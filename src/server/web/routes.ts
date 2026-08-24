import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import { toIsoTimestamp } from '../../shared/time/clock';
import type { Logger } from '../../shared/types/logging';
import { HTTP_ROUTES } from '../../shared/types/protocol';
import { toError } from '../../shared/types/result';
import type { PlayableVideo, PreprocessedVideo } from '../../shared/types/video';
import { readField } from '../../shared/util/decode';
import type { PlayerService } from '../api/playerService';
import { decodeLeaderPublication } from '../domain/leaderPublication';
import type { VideoPathGuard } from '../domain/videoPaths';
import { decodePreprocessedVideo, decodePreprocessedVideoList } from '../domain/videoRecords';

export interface PlayerRouterOptions {
  readonly service: PlayerService;
  readonly logger: Logger;
  /**
   * Applied to every video record in a request body. A body is the least
   * trusted input this process has: `cors()` makes these routes reachable from
   * any page the user happens to have open.
   */
  readonly videoPaths: VideoPathGuard;
}

/** Every command route answers with this, so a client can ignore the body. */
const ACKNOWLEDGED = { ok: true } as const;

type AsyncRequestHandler = (request: Request, response: Response) => Promise<void>;

/**
 * Accepts either the video itself as the body or a `{ video }` wrapper.
 *
 * `express.json` runs in strict mode, so a bare `null` body is rejected before
 * a handler ever sees it; the wrapper is therefore the only way for a client to
 * say "no video" on the routes where that is a legal argument.
 */
const readVideo = (body: unknown, guard: VideoPathGuard): PreprocessedVideo | null => {
  const wrapped = readField(body, 'video');
  return decodePreprocessedVideo(wrapped === undefined ? body : wrapped, guard);
};

const readVideoList = (body: unknown, guard: VideoPathGuard): readonly PreprocessedVideo[] => {
  const wrapped = readField(body, 'videos');
  return decodePreprocessedVideoList(wrapped === undefined ? body : wrapped, guard);
};

const readMessage = (body: unknown): string | null => {
  const message = readField(body, 'message');
  return typeof message === 'string' && message.trim() !== '' ? message : null;
};

/**
 * A 204 is this transport's spelling of `null`. The legacy route sent the JSON
 * literal `null` with a 200, which meant every client had to parse a body
 * before it could tell "here is a video" from "there is nothing to play".
 */
const sendVideo = (response: Response, video: PlayableVideo | null): void => {
  if (video === null) {
    response.status(204).end();
    return;
  }
  response.json(video);
};

const sendBadRequest = (response: Response, reason: string): void => {
  response.status(400).json({ error: reason });
};

/**
 * Maps HTTP onto {@link PlayerService}. Nothing here decides anything: the
 * session owns queue validation, which is why the legacy "retry up to five
 * times when the processed file is missing" block has no counterpart. That
 * block also assigned to a `const`-declared binding, so the one path meant to
 * recover from a missing file threw a TypeError instead.
 */
export const createPlayerRouter = ({
  service,
  logger,
  videoPaths,
}: PlayerRouterOptions): Router => {
  const router = Router();

  /**
   * Express 4 does not await handlers, so a rejected promise would escape as an
   * unhandled rejection and the client would wait for a response that never
   * comes. Every failure becomes a 500 with a JSON body instead.
   */
  const asyncHandler =
    (handle: AsyncRequestHandler): RequestHandler =>
    (request, response) => {
      handle(request, response).catch((thrown: unknown) => {
        const error = toError(thrown);
        logger.error(`${request.method} ${request.path} failed`, error);
        if (response.headersSent) {
          // The status line is already on the wire; cutting the connection is
          // the only way left to tell the client the body is incomplete.
          response.destroy();
          return;
        }
        response.status(500).json({ error: error.message });
      });
    };

  router.get(
    HTTP_ROUTES.config,
    asyncHandler(async (_request, response) => {
      response.json(await service.getConfig());
    }),
  );

  router.get(
    HTTP_ROUTES.status,
    asyncHandler(async (_request, response) => {
      response.json(await service.getStatus());
    }),
  );

  router.get(
    HTTP_ROUTES.detailedStats,
    asyncHandler(async (_request, response) => {
      response.json(await service.getDetailedStats());
    }),
  );

  router.get(
    HTTP_ROUTES.nextVideo,
    asyncHandler(async (_request, response) => {
      sendVideo(response, await service.takeNextVideo());
    }),
  );

  router.get(
    HTTP_ROUTES.previousVideo,
    asyncHandler(async (_request, response) => {
      sendVideo(response, await service.takePreviousVideo());
    }),
  );

  router.post(
    HTTP_ROUTES.ensurePlayable,
    asyncHandler(async (request, response) => {
      const video = readVideo(request.body, videoPaths);
      if (video === null) {
        sendBadRequest(response, 'expected a preprocessed video');
        return;
      }
      sendVideo(response, await service.ensurePlayable(video));
    }),
  );

  router.post(
    HTTP_ROUTES.videoEnded,
    asyncHandler(async (request, response) => {
      const video = readVideo(request.body, videoPaths);
      if (video === null) {
        sendBadRequest(response, 'expected a preprocessed video');
        return;
      }
      await service.recordVideoEnded(video);
      response.json(ACKNOWLEDGED);
    }),
  );

  router.post(
    HTTP_ROUTES.videoError,
    asyncHandler(async (request, response) => {
      const message = readMessage(request.body);
      if (message === null) {
        sendBadRequest(response, 'expected a non-empty message');
        return;
      }
      await service.recordVideoError(message);
      response.json(ACKNOWLEDGED);
    }),
  );

  // The video is optional on both of these: the client may skip before it has
  // anything loaded, so an undecodable body means "no video", not a bad request.
  router.post(
    HTTP_ROUTES.manualSkip,
    asyncHandler(async (request, response) => {
      await service.recordManualSkip(readVideo(request.body, videoPaths));
      response.json(ACKNOWLEDGED);
    }),
  );

  router.post(
    HTTP_ROUTES.returnToPrevious,
    asyncHandler(async (request, response) => {
      await service.recordReturnToPrevious(readVideo(request.body, videoPaths));
      response.json(ACKNOWLEDGED);
    }),
  );

  router.post(
    HTTP_ROUTES.syncPlaybackQueue,
    asyncHandler(async (request, response) => {
      await service.syncPlaybackQueue(readVideoList(request.body, videoPaths));
      response.json(ACKNOWLEDGED);
    }),
  );

  router.get(
    HTTP_ROUTES.getLeaderState,
    asyncHandler(async (_request, response) => {
      response.json(await service.getLeaderState());
    }),
  );

  router.post(
    HTTP_ROUTES.publishLeaderState,
    asyncHandler(async (request, response) => {
      // Shared with the IPC handler, so the two transports cannot decode the
      // same protocol message differently. They once did, and the Electron copy
      // was the one that was wrong.
      const published = decodeLeaderPublication(request.body, videoPaths);
      if (published === null) {
        sendBadRequest(response, 'expected a preprocessed video');
        return;
      }
      await service.publishLeaderState(published);
      response.json(ACKNOWLEDGED);
    }),
  );

  router.post(
    HTTP_ROUTES.locatePlayable,
    asyncHandler(async (request, response) => {
      const video = readVideo(request.body, videoPaths);
      if (video === null) {
        sendBadRequest(response, 'expected a preprocessed video');
        return;
      }
      sendVideo(response, await service.locatePlayable(video));
    }),
  );

  router.post(
    HTTP_ROUTES.toggleArchiveFlag,
    asyncHandler(async (request, response) => {
      const video = readVideo(request.body, videoPaths);
      if (video === null) {
        sendBadRequest(response, 'expected a preprocessed video');
        return;
      }
      response.json({ flagged: await service.toggleArchiveFlag(video) });
    }),
  );

  router.get(HTTP_ROUTES.health, (_request, response) => {
    response.json({ status: 'ok', timestamp: toIsoTimestamp(Date.now()) });
  });

  return router;
};

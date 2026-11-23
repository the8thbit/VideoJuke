import type { ConfigChangeImpact } from '../config/changeImpact';
import type { AppConfig, ConfigIssue } from './config';
import type { LogEntry } from './logging';

/**
 * Everything the options panel needs to show the settings as they stand.
 *
 * `config` is the effective configuration - the defaults with config.json laid
 * over them - because that is what the panel has to display: a field the user
 * never wrote still has a value, and it is the default one. The one exception is
 * the access token, which is blanked: the panel can be opened by anyone holding
 * the token already, but there is no reason to put it on screen.
 */
export interface EditableConfig {
  readonly config: AppConfig;
  /**
   * The seasonal entries exactly as config.json spells them. They are edited as
   * JSON rather than as a form, and the normalised form would rewrite the
   * user's time conditions into an equivalent but unfamiliar shape.
   */
  readonly seasonalDirectories: unknown;
  readonly issues: readonly ConfigIssue[];
  /** Where the settings live on the server, for the panel to name. */
  readonly configFile: string;
  /** Bumped by every change, saved or edited by hand, so clients can tell. */
  readonly revision: number;
}

/**
 * A partial configuration in config.json's canonical spelling: only the fields
 * the user changed, nested as they are in the file. Arrays replace wholesale.
 */
export type ConfigPatch = Readonly<Record<string, unknown>>;

export type ConfigSaveResult =
  | {
      readonly ok: true;
      readonly revision: number;
      /** What the server is now doing about it; the banner explains the rest. */
      readonly impact: ConfigChangeImpact;
      /** Changed fields that only take effect after a restart. */
      readonly restartRequired: readonly string[];
      readonly issues: readonly ConfigIssue[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      /** The problems with the submitted values; nothing was written. */
      readonly issues: readonly ConfigIssue[];
    };

/** A log entry with a number clients use to tell which ones they have seen. */
export interface LogRecord extends LogEntry {
  readonly sequence: number;
}

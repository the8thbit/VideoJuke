const { app } = require('electron');
const path = require('path');

// Simple launcher
app.whenReady().then(() => {
    require(path.join(__dirname, 'src', 'server', 'server.js'));
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (require('electron').BrowserWindow.getAllWindows().length === 0) {
        require(path.join(__dirname, 'src', 'server', 'server.js')).createWindow();
    }
});
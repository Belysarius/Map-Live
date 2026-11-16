const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapLive', {
  onActivity(listener) {
    ipcRenderer.on('activity', (_event, value) => listener(value));
  },
  selectView(view) {
    ipcRenderer.send('map-view', view);
  },
});

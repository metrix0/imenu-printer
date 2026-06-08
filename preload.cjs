const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: config => ipcRenderer.invoke('config:save', config),
    detectPrinters: () => ipcRenderer.invoke('printers:detect'),
    testPrinter: config => ipcRenderer.invoke('printer:test', config),
    login: payload => ipcRenderer.invoke('auth:login', payload),
    logout: () => ipcRenderer.invoke('auth:logout'),

    onLog: callback => {
        ipcRenderer.on('log', (_, message) => callback(message))
    },
})
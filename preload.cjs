const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('config:get'),
    saveConfig: config => ipcRenderer.invoke('config:save', config),
    detectPrinters: () => ipcRenderer.invoke('printers:detect'),
    testPrinter: config => ipcRenderer.invoke('printer:test', config),
    getPrintHistory: () => ipcRenderer.invoke('orders:history'),
    reprintOrder: orderId => ipcRenderer.invoke('orders:reprint', orderId),
    login: payload => ipcRenderer.invoke('auth:login', payload),
    loginWithGoogle: () => ipcRenderer.invoke('auth:google'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
    checkForUpdates: () => ipcRenderer.invoke('update:check'),

    onUpdateStatus: callback => {
        ipcRenderer.on('update:status', (_, status) => callback(status))
    },

    onLog: callback => {
        ipcRenderer.on('log', (_, message) => callback(message))
    },
})
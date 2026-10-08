const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('config:get'),
    isAuthenticated: () => ipcRenderer.invoke('auth:status'),
    onAuthRequired: callback => {
        ipcRenderer.on('auth:required', () => callback())
    },
    saveConfig: config => ipcRenderer.invoke('config:save', config),
    selectReceiptLogo: () => ipcRenderer.invoke('receipt-logo:select'),
    getReceiptLogoPreview: imagePath => ipcRenderer.invoke('receipt-logo:preview', imagePath),
    detectPrinters: () => ipcRenderer.invoke('printers:detect'),
    testPrinter: config => ipcRenderer.invoke('printer:test', config),
    getPrintHistory: () => ipcRenderer.invoke('orders:history'),
    reprintOrder: orderId => ipcRenderer.invoke('orders:reprint', orderId),
    login: payload => ipcRenderer.invoke('auth:login', payload),
    loginWithGoogle: () => ipcRenderer.invoke('auth:google'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
    checkForUpdates: () => ipcRenderer.invoke('update:check'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    openSupport: () => ipcRenderer.invoke('support:open'),
    quitApplication: () => ipcRenderer.invoke('app:quit'),

    onUpdateStatus: callback => {
        ipcRenderer.on('update:status', (_, status) => callback(status))
    },

    onLog: callback => {
        ipcRenderer.on('log', (_, message) => callback(message))
    },
})
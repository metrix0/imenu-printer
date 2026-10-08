const WebSocket = require('ws')
const { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeImage, shell, Tray, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const { exec, spawn } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const { SerialPort } = require('serialport')
const iconv = require('iconv-lite')

const baseDir = app.getPath('userData')
const configPath = path.join(baseDir, 'config.json')

const SUPABASE_URL = 'https://mjogdsnxbwhbqcoijrwt.supabase.co'
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qb2dkc254YndoYnFjb2lqcnd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2NjY4MzUsImV4cCI6MjA3NzI0MjgzNX0.S1XLgP7U9ugTXKh4YTrEvzDaroVMN0LhxWc8B3DnkII"
const PRINT_API_URL = process.env.IMENU_PRINTER_API_URL || 'https://www.imenuapp.com.br/api/printer'
const authSessionPath = path.join(baseDir, 'auth-session.json')
const GOOGLE_AUTH_CALLBACK_HOST = '127.0.0.1'
const GOOGLE_AUTH_CALLBACK_PORT = 47819
const GOOGLE_AUTH_CALLBACK_PATH = '/auth/callback'
const GOOGLE_AUTH_CALLBACK_URL = `http://${GOOGLE_AUTH_CALLBACK_HOST}:${GOOGLE_AUTH_CALLBACK_PORT}${GOOGLE_AUTH_CALLBACK_PATH}`
const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000

let win = null
let tray = null
let forceQuit = false
let printerLoopRunning = false
let stopPrinterLoop = false
let printerWakeResolve = null
let printerWakePending = false
let queueChannel = null
let authClient = null
let googleLoginInProgress = false

const RECEIPT_WIDTH = 40
const RECEIPT_LOGO_MAX_WIDTH = 320
const RECEIPT_LOGO_MAX_HEIGHT = 160
const RECEIPT_LOGO_THRESHOLD = 180
const MAX_PRINT_ATTEMPTS = 3
const FINAL_PRINT_RETRY_DELAY_MS = 30 * 1000
const PRINT_OPERATION_TIMEOUT_MS = 20 * 1000
const RECEIPT_BUILD_TIMEOUT_MS = 15 * 1000
const UPDATE_INITIAL_DELAY_MS = 15 * 1000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const UPDATE_REPOSITORY = 'metrix0/imenu-printer'
const SUPPORT_WHATSAPP_URL = 'https://wa.me/5519997235394?text=' + encodeURIComponent('Olá, preciso de ajuda com o iMenu Impressora!')

let updateCheckInProgress = false
let pendingUpdate = null
let updateInstallScheduled = false
const receiptLogoCache = new Map()
let updateState = {
    status: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progress: null,
    message: 'Atualizações automáticas ativadas.',
}

const ESC = {
    init: '\x1B\x40',

    alignLeft: '\x1B\x61\x00',
    alignCenter: '\x1B\x61\x01',

    fontA: '\x1B\x4D\x00',

    boldOn: '\x1B\x45\x01',
    boldOff: '\x1B\x45\x00',

    normalSize: '\x1D\x21\x00',
    doubleSize: '\x1D\x21\x11',

    underlineOff: '\x1B\x2D\x00',
    charSpacingNormal: '\x1B\x20\x00',

    densityStrong1: '\x1D\x28\x45\x04\x00\x05\x05\x05\x05',
    densityStrong2: '\x12\x23\x07',

    cut: '\x1D\x56\x41\x10',
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function createOperationError(message, retryable = true) {
    const error = new Error(message)
    error.printRetryable = retryable
    return error
}

function withTimeout(promise, timeoutMs, message) {
    let timeout = null

    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(createOperationError(message, true))
        }, timeoutMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout) clearTimeout(timeout)
    })
}

function sendLog(message) {
    console.log(message)
    if (win) win.webContents.send('log', String(message))
}

function isLegacyBuild() {
    return String(app.getName() || '').toLowerCase().includes('legacy')
}

function publishUpdateStatus(patch = {}) {
    updateState = {
        ...updateState,
        ...patch,
        currentVersion: app.getVersion(),
    }

    if (win && !win.isDestroyed()) {
        win.webContents.send('update:status', updateState)
    }

    return updateState
}

function compareVersions(left, right) {
    const leftParts = String(left || '').replace(/^v/i, '').split('.').map(Number)
    const rightParts = String(right || '').replace(/^v/i, '').split('.').map(Number)
    const length = Math.max(leftParts.length, rightParts.length)

    for (let index = 0; index < length; index += 1) {
        const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0
        const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0

        if (leftValue > rightValue) return 1
        if (leftValue < rightValue) return -1
    }

    return 0
}

function requestJson(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                'User-Agent': 'iMenu-Impressora',
                Accept: 'application/vnd.github+json',
            },
        }, response => {
            if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location &&
                redirectCount < 5
            ) {
                response.resume()
                requestJson(new URL(response.headers.location, url).toString(), redirectCount + 1)
                    .then(resolve, reject)
                return
            }

            if (response.statusCode !== 200) {
                response.resume()
                reject(new Error(`Falha ao verificar atualização (HTTP ${response.statusCode}).`))
                return
            }

            let body = ''
            response.setEncoding('utf8')
            response.on('data', chunk => {
                body += chunk
            })
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body))
                } catch (error) {
                    reject(error)
                }
            })
        })

        request.setTimeout(15000, () => {
            request.destroy(new Error('Tempo limite ao verificar atualização.'))
        })
        request.on('error', reject)
    })
}

function downloadUpdateFile(url, filePath, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { 'User-Agent': 'iMenu-Impressora' },
        }, response => {
            if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location &&
                redirectCount < 8
            ) {
                response.resume()
                downloadUpdateFile(
                    new URL(response.headers.location, url).toString(),
                    filePath,
                    redirectCount + 1
                ).then(resolve, reject)
                return
            }

            if (response.statusCode !== 200) {
                response.resume()
                reject(new Error(`Falha ao baixar atualização (HTTP ${response.statusCode}).`))
                return
            }

            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            const tempPath = `${filePath}.download`
            const stream = fs.createWriteStream(tempPath)
            const total = Number(response.headers['content-length'] || 0)
            let received = 0
            let lastReported = -1

            response.on('data', chunk => {
                received += chunk.length
                if (total > 0) {
                    const progress = Math.min(100, Math.floor((received / total) * 100))
                    if (progress !== lastReported && progress % 5 === 0) {
                        lastReported = progress
                        publishUpdateStatus({
                            status: 'downloading',
                            progress,
                            message: `Baixando atualização... ${progress}%`,
                        })
                    }
                }
            })

            response.pipe(stream)
            stream.on('finish', () => {
                stream.close(() => {
                    try {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
                        fs.renameSync(tempPath, filePath)
                        resolve(filePath)
                    } catch (error) {
                        reject(error)
                    }
                })
            })
            stream.on('error', error => {
                stream.destroy()
                try {
                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
                } catch {}
                reject(error)
            })
        })

        request.setTimeout(30000, () => {
            request.destroy(new Error('Tempo limite ao baixar atualização.'))
        })
        request.on('error', reject)
    })
}

async function checkForAppUpdate() {
    if (isLegacyBuild()) {
        return publishUpdateStatus({
            status: 'legacy',
            availableVersion: null,
            progress: null,
            message: 'Atualizações do Windows 7/8 são instaladas manualmente.',
        })
    }

    if (!app.isPackaged) {
        return publishUpdateStatus({
            status: 'development',
            availableVersion: null,
            progress: null,
            message: 'Atualizações automáticas ficam ativas no aplicativo instalado.',
        })
    }

    if (updateCheckInProgress) return updateState
    updateCheckInProgress = true

    publishUpdateStatus({
        status: 'checking',
        progress: null,
        message: 'Verificando atualizações...',
    })

    try {
        const release = await requestJson(
            `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
        )
        const version = String(release?.tag_name || '').replace(/^v/i, '').trim()

        if (!version || compareVersions(version, app.getVersion()) <= 0) {
            pendingUpdate = null
            return publishUpdateStatus({
                status: 'current',
                availableVersion: null,
                progress: null,
                message: `Versão ${app.getVersion()} atualizada.`,
            })
        }

        const installer = (release.assets || []).find(asset =>
            /\.exe$/i.test(String(asset?.name || '')) &&
            !/\.blockmap$/i.test(String(asset?.name || '')) &&
            Number(asset?.size || 0) > 1000000
        )

        if (!installer?.browser_download_url) {
            throw new Error('A nova versão não possui um instalador válido.')
        }

        const updateDir = path.join(baseDir, 'updates', version)
        const installerPath = path.join(updateDir, `iMenu-Impressora-${version}.exe`)
        const expectedSize = Number(installer.size || 0)

        publishUpdateStatus({
            status: 'available',
            availableVersion: version,
            progress: 0,
            message: `Nova versão ${version} encontrada.`,
        })

        const existingSize = fs.existsSync(installerPath)
            ? fs.statSync(installerPath).size
            : 0

        if (!expectedSize || existingSize !== expectedSize) {
            publishUpdateStatus({
                status: 'downloading',
                availableVersion: version,
                progress: 0,
                message: 'Baixando atualização...',
            })
            await downloadUpdateFile(installer.browser_download_url, installerPath)
        }

        pendingUpdate = {
            version,
            installerPath,
        }

        return publishUpdateStatus({
            status: 'ready',
            availableVersion: version,
            progress: 100,
            message: `Versão ${version} pronta.`,
        })
    } catch (error) {
        return publishUpdateStatus({
            status: 'error',
            progress: null,
            message: 'Não foi possível verificar atualizações agora.',
        })
    } finally {
        updateCheckInProgress = false
    }
}

function installPendingUpdate() {
    if (
        updateInstallScheduled ||
        isLegacyBuild() ||
        !app.isPackaged ||
        !pendingUpdate?.installerPath ||
        !fs.existsSync(pendingUpdate.installerPath)
    ) {
        return {
            ok: false,
            status: publishUpdateStatus({
                status: 'error',
                progress: null,
                message: 'A atualização ainda não está pronta.',
            }),
        }
    }

    updateInstallScheduled = true

    try {
        const child = spawn(
            pendingUpdate.installerPath,
            ['/S'],
            {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            }
        )
        child.unref()

        const status = publishUpdateStatus({
            status: 'installing',
            availableVersion: pendingUpdate.version,
            progress: 100,
            message: 'Instalando atualização...',
        })

        forceQuit = true
        setTimeout(() => app.quit(), 250)

        return { ok: true, status }
    } catch (error) {
        updateInstallScheduled = false
        return {
            ok: false,
            status: publishUpdateStatus({
                status: 'error',
                progress: null,
                message: 'Não foi possível iniciar a atualização.',
            }),
        }
    }
}

function scheduleUpdateChecks() {
    if (isLegacyBuild() || !app.isPackaged) return

    const initialTimer = setTimeout(() => {
        checkForAppUpdate().catch(() => {})
    }, UPDATE_INITIAL_DELAY_MS)
    initialTimer.unref?.()

    const interval = setInterval(() => {
        checkForAppUpdate().catch(() => {})
    }, UPDATE_CHECK_INTERVAL_MS)
    interval.unref?.()
}

function readConfig() {
    const defaults = {
        RESTAURANT_ID: '',
        RESTAURANT_NAME: '',
        LOGGED_IN_EMAIL: '',

        PRINTER_MODE: 'bluetooth',
        PRINTER_COM_PORT: '',
        PRINTER_BAUD_RATE: 9600,

        PRINTER_NAME: '',
        PRINTER_IP: '',
        PRINTER_PORT: 9100,
        PRINT_TWO_COPIES: false,

        RECEIPT_TITLE: 'COZINHA',
        RECEIPT_FOOTER_TEXT: '',
        RECEIPT_SHOW_ORDER_TIME: true,
        RECEIPT_SHOW_CUSTOMER_NAME: true,
        RECEIPT_SHOW_CUSTOMER_PHONE: true,
        RECEIPT_SHOW_ADDRESS: true,
        RECEIPT_SHOW_PAYMENT: true,
        RECEIPT_SHOW_ITEM_PRICES: true,
        RECEIPT_SHOW_SUBITEMS: true,
        RECEIPT_SHOW_OBSERVATIONS: true,
        RECEIPT_SHOW_TOTALS: true,
        RECEIPT_SHOW_LOGO: false,
        RECEIPT_LOGO_PATH: '',
        RECEIPT_LOGO_POSITION: 'top',

        POLL_EVERY_MS: 60000,
        CONNECT_TIMEOUT_MS: 5000,
    }

    if (!fs.existsSync(configPath)) {
        return defaults
    }

    try {
        return {
            ...defaults,
            ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
        }
    } catch (error) {
        sendLog(`Configuração inválida restaurada: ${error.message}`)
        return defaults
    }
}

function saveConfig(config) {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

const authStorage = {
    getItem(key) {
        try {
            const stored = JSON.parse(fs.readFileSync(authSessionPath, 'utf8'))
            if (stored.key !== key) return null
            if (stored.encrypted) {
                return safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
            }
            return stored.value || null
        } catch {
            return null
        }
    },
    setItem(key, value) {
        fs.mkdirSync(baseDir, { recursive: true })
        const encrypted = safeStorage.isEncryptionAvailable()
        const stored = {
            key,
            encrypted,
            value: encrypted
                ? safeStorage.encryptString(value).toString('base64')
                : value,
        }
        fs.writeFileSync(authSessionPath, JSON.stringify(stored), { mode: 0o600 })
    },
    removeItem(key) {
        try {
            if (fs.existsSync(authSessionPath)) fs.unlinkSync(authSessionPath)
        } catch {}
    },
}

function getSupabase(useServiceRole = false, authOptions = null) {
    if (useServiceRole) {
        throw new Error('O acesso privilegiado não está disponível neste aplicativo.')
    }
    if (!authOptions && authClient) return authClient

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            storage: authStorage,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            ...(authOptions || {}),
        },
        realtime: { transport: WebSocket },
    })

    if (!authOptions) authClient = client
    return client
}

async function isAuthenticated() {
    const { data: { user }, error } = await getSupabase().auth.getUser()
    return !error && Boolean(user)
}

function requireNewLogin() {
    stopLoop()
    if (win && !win.isDestroyed()) {
        win.webContents.send('auth:required')
    }
}

async function printerApi(action, payload = {}) {
    const { data: { session }, error } = await getSupabase().auth.getSession()
    if (error || !session?.access_token) {
        requireNewLogin()
        throw new Error('Sessão expirada. Faça login novamente.')
    }

    const url = new URL(PRINT_API_URL)
    const body = JSON.stringify({
        action,
        restaurant_id: readConfig().RESTAURANT_ID,
        ...payload,
    })

    return await new Promise((resolve, reject) => {
        const request = https.request(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${session.access_token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, response => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', chunk => { text += chunk })
            response.on('end', () => {
                let data
                try {
                    data = JSON.parse(text)
                } catch {
                    reject(new Error('Resposta inválida do servidor de impressão.'))
                    return
                }

                if (response.statusCode === 401 || response.statusCode === 403) {
                    requireNewLogin()
                }
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(data.error || `Falha no servidor (HTTP ${response.statusCode}).`))
                    return
                }
                resolve(data)
            })
        })
        request.setTimeout(15000, () => request.destroy(new Error('Tempo limite de conexão com o servidor de impressão.')))
        request.on('error', reject)
        request.end(body)
    })
}

function wakePrinter() {
    printerWakePending = true
    if (printerWakeResolve) {
        const wake = printerWakeResolve
        printerWakeResolve = null
        wake()
    }
}

async function waitForPrinterWake(timeoutMs) {
    if (printerWakePending) {
        printerWakePending = false
        return
    }
    await new Promise(resolve => {
        let timeout
        const wake = () => {
            clearTimeout(timeout)
            resolve()
        }
        printerWakeResolve = wake
        timeout = setTimeout(() => {
            if (printerWakeResolve === wake) printerWakeResolve = null
            resolve()
        }, timeoutMs)
    })
    printerWakePending = false
}

function createMemoryAuthStorage() {
    const values = new Map()

    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null
        },
        setItem(key, value) {
            values.set(key, value)
        },
        removeItem(key) {
            values.delete(key)
        },
    }
}

async function listComPorts() {
    const ports = await SerialPort.list()

    return ports.map(port => ({
        path: port.path,
        manufacturer: port.manufacturer || '',
        friendlyName: port.friendlyName || '',
        serialNumber: port.serialNumber || '',
        type: 'bluetooth-or-serial',
    }))
}

function normalizeComPortName(value) {
    return String(value || '')
        .trim()
        .replace(/:$/, '')
        .toUpperCase()
}

function listWindowsPrinters() {
    return new Promise(resolve => {
        const cmd = `powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName | ConvertTo-Json -Compress"`

        exec(cmd, (err, stdout) => {
            if (err) {
                resolve([])
                return
            }

            try {
                const raw = String(stdout || '').trim()
                if (!raw) {
                    resolve([])
                    return
                }

                const parsed = JSON.parse(raw)
                const rows = Array.isArray(parsed) ? parsed : [parsed]

                resolve(rows
                    .map(printer => ({
                        name: String(printer.Name || '').trim(),
                        portName: String(printer.PortName || '').trim(),
                        type: 'windows-printer',
                    }))
                    .filter(printer => printer.name))
            } catch {
                resolve([])
            }
        })
    })
}

function putSavedSelectionFirst(items, savedValue, valueKey, missingItemFactory) {
    const saved = String(savedValue || '').trim()

    if (!saved) {
        return items
    }

    const existingIndex = items.findIndex(
        item => String(item?.[valueKey] || '').trim() === saved
    )

    if (existingIndex === 0) {
        return items
    }

    if (existingIndex > 0) {
        const reordered = [...items]
        const [selected] = reordered.splice(existingIndex, 1)
        reordered.unshift(selected)
        return reordered
    }

    return [missingItemFactory(saved), ...items]
}

async function detectPrinters() {
    const config = readConfig()
    const detectedWindowsPrinters = await listWindowsPrinters()
    const detectedComPorts = (await listComPorts()).map(port => {
        const portName = normalizeComPortName(port.path)
        const matchingPrinter = detectedWindowsPrinters.find(
            printer => normalizeComPortName(printer.portName) === portName
        )

        if (!matchingPrinter) {
            return port
        }

        return {
            ...port,
            friendlyName: matchingPrinter.name,
        }
    })

    const comPorts = putSavedSelectionFirst(
        detectedComPorts,
        config.PRINTER_COM_PORT,
        'path',
        savedPath => ({
            path: savedPath,
            manufacturer: '',
            friendlyName: 'Salva anteriormente (não detectada agora)',
            serialNumber: '',
            type: 'bluetooth-or-serial',
        })
    )

    const windowsPrinters = putSavedSelectionFirst(
        detectedWindowsPrinters,
        config.PRINTER_NAME,
        'name',
        savedName => ({
            name: savedName,
            type: 'windows-printer',
        })
    )

    return {
        comPorts,
        windowsPrinters,
    }
}

function normalizePrinterText(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ç/g, 'c')
        .replace(/Ç/g, 'C')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/º/g, 'o')
        .replace(/ª/g, 'a')
}

function encodePrinterData(value) {
    if (Buffer.isBuffer(value)) return value
    return iconv.encode(normalizePrinterText(value), 'cp850')
}

function getReceiptLogoSetting(config, via, suffix, fallback) {
    const primaryKey = `RECEIPT_${suffix}`
    const viaKey = `RECEIPT_2_${suffix}`

    if (via === 2 && Object.prototype.hasOwnProperty.call(config, viaKey)) {
        return config[viaKey]
    }

    if (Object.prototype.hasOwnProperty.call(config, primaryKey)) {
        return config[primaryKey]
    }

    return fallback
}

function normalizeReceiptLogoPosition(value) {
    return String(value || '').toLowerCase() === 'bottom' ? 'bottom' : 'top'
}

function loadMonochromeReceiptLogo(imagePath) {
    const normalizedPath = String(imagePath || '').trim()
    if (!normalizedPath || !fs.existsSync(normalizedPath)) return null

    const stats = fs.statSync(normalizedPath)
    const cacheKey = `${normalizedPath}:${stats.mtimeMs}:${stats.size}`
    const cached = receiptLogoCache.get(normalizedPath)
    if (cached?.cacheKey === cacheKey) return cached

    const source = nativeImage.createFromPath(normalizedPath)
    if (source.isEmpty()) return null

    const sourceSize = source.getSize()
    if (sourceSize.width < 1 || sourceSize.height < 1) return null

    const scale = Math.min(
        1,
        RECEIPT_LOGO_MAX_WIDTH / sourceSize.width,
        RECEIPT_LOGO_MAX_HEIGHT / sourceSize.height
    )
    const width = Math.max(1, Math.round(sourceSize.width * scale))
    const height = Math.max(1, Math.round(sourceSize.height * scale))
    const resized = source.resize({ width, height, quality: 'best' })
    const bitmap = Buffer.from(resized.toBitmap())

    for (let index = 0; index < bitmap.length; index += 4) {
        const alpha = bitmap[index + 3] / 255
        const blue = bitmap[index] * alpha + 255 * (1 - alpha)
        const green = bitmap[index + 1] * alpha + 255 * (1 - alpha)
        const red = bitmap[index + 2] * alpha + 255 * (1 - alpha)
        const luminance = (red * 0.299) + (green * 0.587) + (blue * 0.114)
        const value = luminance < RECEIPT_LOGO_THRESHOLD ? 0 : 255

        bitmap[index] = value
        bitmap[index + 1] = value
        bitmap[index + 2] = value
        bitmap[index + 3] = 255
    }

    const monochromeImage = nativeImage.createFromBitmap(bitmap, { width, height })
    const processed = {
        cacheKey,
        width,
        height,
        bitmap,
        previewDataUrl: monochromeImage.toDataURL(),
    }

    receiptLogoCache.set(normalizedPath, processed)
    return processed
}

function createReceiptLogoRasterBuffer(imagePath) {
    const processed = loadMonochromeReceiptLogo(imagePath)
    if (!processed) return null

    const rowBytes = Math.ceil(processed.width / 8)
    const raster = Buffer.alloc(rowBytes * processed.height)

    for (let y = 0; y < processed.height; y += 1) {
        for (let x = 0; x < processed.width; x += 1) {
            const pixelOffset = (y * processed.width + x) * 4
            if (processed.bitmap[pixelOffset] >= 128) continue

            const byteOffset = y * rowBytes + Math.floor(x / 8)
            raster[byteOffset] |= 0x80 >> (x % 8)
        }
    }

    const header = Buffer.from([
        0x1d, 0x76, 0x30, 0x00,
        rowBytes & 0xff,
        (rowBytes >> 8) & 0xff,
        processed.height & 0xff,
        (processed.height >> 8) & 0xff,
    ])

    return Buffer.concat([
        encodePrinterData(ESC.alignCenter),
        header,
        raster,
        Buffer.from('\n'),
        encodePrinterData(ESC.alignLeft),
    ])
}

function createReceiptLogoBuffer(config, via) {
    const enabled = getReceiptLogoSetting(config, via, 'SHOW_LOGO', false) === true
    if (!enabled) return null

    const imagePath = String(getReceiptLogoSetting(config, via, 'LOGO_PATH', '') || '').trim()
    if (!imagePath) return null

    return createReceiptLogoRasterBuffer(imagePath)
}

function getReceiptLogoPreviewPayload(imagePath) {
    const processed = loadMonochromeReceiptLogo(imagePath)
    return {
        exists: Boolean(processed),
        fileName: path.basename(String(imagePath || '')),
        previewDataUrl: processed?.previewDataUrl || null,
    }
}

function printRaw(output, config) {
    const bytes = encodePrinterData(output)
    const mode = String(config.PRINTER_MODE || 'ethernet').toLowerCase()

    if (mode === 'usb') {
        return printUsb(bytes, config)
    }

    if (mode === 'bluetooth') {
        return printBluetooth(bytes, config)
    }

    return printEthernet(bytes, config)
}

function getPrintCopies(config) {
    return config.PRINT_TWO_COPIES === true ? 2 : 1
}

async function printConfiguredCopies(receipts, config) {
    const copies = getPrintCopies(config)
    const receiptList = Array.isArray(receipts) ? receipts : [receipts]

    for (let copy = 1; copy <= copies; copy += 1) {
        const receipt = receiptList[Math.min(copy - 1, receiptList.length - 1)]

        try {
            await printRaw(receipt, config)
        } catch (error) {
            if (copy > 1 && error && typeof error === 'object') {
                error.printRetryable = false
            }
            throw error
        }

        if (copy < copies) {
            await sleep(300)
        }
    }
}

function printUsb(bytes, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_NAME) {
            reject(new Error('Missing PRINTER_NAME'))
            return
        }

        const filePath = path.join(os.tmpdir(), `imenu_raw_print_${Date.now()}.bin`)
        fs.writeFileSync(filePath, bytes)

        const printerName = String(config.PRINTER_NAME).replaceAll("'", "''")
        const safeFilePath = filePath.replaceAll("'", "''")

        const ps = `
$printerName = '${printerName}'
$filePath = '${safeFilePath}'

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "iMenu Pedido";
        di.pDataType = "RAW";

        if (!OpenPrinter(szPrinterName.Normalize(), out hPrinter, IntPtr.Zero))
            return false;

        bool success = false;

        if (StartDocPrinter(hPrinter, 1, di))
        {
            if (StartPagePrinter(hPrinter))
            {
                IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);

                int dwWritten;
                success = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);

                Marshal.FreeCoTaskMem(pUnmanagedBytes);
                EndPagePrinter(hPrinter);
            }

            EndDocPrinter(hPrinter);
        }

        ClosePrinter(hPrinter);
        return success;
    }
}
"@

[byte[]]$bytes = [System.IO.File]::ReadAllBytes($filePath)
$ok = [RawPrinterHelper]::SendBytesToPrinter($printerName, $bytes)

if (-not $ok) {
  throw "Falha ao enviar impressão RAW para $printerName"
}
`

        const psPath = path.join(os.tmpdir(), `imenu_raw_print_${Date.now()}.ps1`)
        fs.writeFileSync(psPath, ps, 'utf8')

        exec(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`,
            { timeout: PRINT_OPERATION_TIMEOUT_MS },
            err => {
                try {
                    fs.unlinkSync(filePath)
                } catch {}

                try {
                    fs.unlinkSync(psPath)
                } catch {}

                if (err) {
                    if (err.killed) {
                        err.printRetryable = false
                    }
                    reject(err)
                } else {
                    resolve()
                }
            }
        )
    })
}

function printEthernet(bytes, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_IP) {
            reject(createOperationError('Missing PRINTER_IP'))
            return
        }

        if (!config.PRINTER_PORT) {
            reject(createOperationError('Missing PRINTER_PORT'))
            return
        }

        const socket = new net.Socket()
        let settled = false
        let writeStarted = false

        const finishError = (error, retryable = !writeStarted) => {
            if (settled) return
            settled = true
            socket.destroy()

            if (error && typeof error === 'object') {
                error.printRetryable = retryable
            }

            reject(error)
        }

        const finishSuccess = () => {
            if (settled) return
            settled = true
            socket.end()
            resolve()
        }

        socket.setTimeout(
            Math.max(Number(config.CONNECT_TIMEOUT_MS || 5000), PRINT_OPERATION_TIMEOUT_MS)
        )

        socket.on('error', error => {
            finishError(error)
        })

        socket.on('timeout', () => {
            finishError(
                createOperationError(
                    'Tempo limite ao comunicar com a impressora.',
                    !writeStarted
                ),
                !writeStarted
            )
        })

        socket.connect(Number(config.PRINTER_PORT), config.PRINTER_IP, () => {
            if (settled) return

            writeStarted = true
            socket.write(bytes, error => {
                if (settled) return

                if (error) {
                    finishError(error, false)
                    return
                }

                finishSuccess()
            })
        })
    })
}

function printBluetooth(bytes, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_COM_PORT) {
            reject(createOperationError('Missing PRINTER_COM_PORT'))
            return
        }

        const port = new SerialPort({
            path: config.PRINTER_COM_PORT,
            baudRate: Number(config.PRINTER_BAUD_RATE || 9600),
            autoOpen: false,
        })
        let settled = false
        let writeStarted = false

        const closePort = () => {
            if (port.isOpen) {
                port.close(() => {})
            }
        }

        const finishError = (error, retryable = !writeStarted) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            closePort()

            if (error && typeof error === 'object') {
                error.printRetryable = retryable
            }

            reject(error)
        }

        const finishSuccess = () => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve()
            closePort()
        }

        const timeout = setTimeout(() => {
            finishError(
                createOperationError(
                    'Tempo limite ao comunicar com a impressora Bluetooth.',
                    !writeStarted
                ),
                !writeStarted
            )
        }, PRINT_OPERATION_TIMEOUT_MS)

        port.on('error', error => {
            finishError(error)
        })

        port.open(error => {
            if (settled) {
                closePort()
                return
            }

            if (error) {
                finishError(error, true)
                return
            }

            writeStarted = true
            port.write(bytes, error => {
                if (settled) {
                    closePort()
                    return
                }

                if (error) {
                    finishError(error, false)
                    return
                }

                port.drain(error => {
                    if (settled) {
                        closePort()
                        return
                    }

                    if (error) {
                        finishError(error, false)
                        return
                    }

                    finishSuccess()
                })
            })
        })
    })
}

async function getNextJob(supabase, config) {
    const response = await printerApi('next_job')
    return response.job || null
}

async function claimJob(supabase, id, attempt) {
    const response = await printerApi('claim_job', { job_id: id, attempt })
    return response.claimed === true
}

async function updateQueuedJobFailure(supabase, id, attempt, patch) {
    await printerApi('queued_failure', {
        job_id: id,
        attempt,
        status: patch.status,
        last_error: patch.last_error,
    })
}

async function updateJob(supabase, id, patch) {
    await printerApi('update_job', {
        job_id: id,
        status: patch.status,
        last_error: patch.last_error,
    })
}

async function recoverInterruptedJobs(supabase, config) {
    const response = await printerApi('recover')
    if (response.recovered) {
        sendLog(`Fila recuperada: ${response.recovered} pedido(s) interrompido(s) liberado(s).`)
    }
}

async function getRecentPrintHistory(limit = 15) {
    if (!readConfig().RESTAURANT_ID) return []
    const response = await printerApi('history', { limit })
    return response.history || []
}

async function reprintOrder(orderId) {
    const config = readConfig()
    if (!config.RESTAURANT_ID) {
        throw new Error('Faça login antes de reimprimir um pedido.')
    }
    if (!orderId) {
        throw new Error('Pedido inválido.')
    }

    const order = await printerApi('reprint_check', { order_id: orderId })
    const displayId = order.display_id || String(orderId).slice(0, 8)
    const copies = getPrintCopies(config)

    sendLog(`Reimprimindo pedido #${displayId}${copies === 2 ? ' (2 vias)' : ''}`)

    const receipts = await buildConfiguredReceipts(null, orderId, config)
    await printConfiguredCopies(receipts, config)

    sendLog(`Reimpresso pedido #${displayId}${copies === 2 ? ' (2 vias)' : ''}`)
    return { ok: true }
}

function printerStart() {
    return [
        ESC.init,
        ESC.alignLeft,
        ESC.fontA,
        ESC.normalSize,
        ESC.boldOff,
        ESC.underlineOff,
        ESC.charSpacingNormal,
        ESC.densityStrong1,
        ESC.densityStrong2,
    ].join('')
}

function money(cents) {
    const numeric = Number(cents)

    if (!Number.isFinite(numeric)) {
        return 'R$ 0,00'
    }

    return `R$ ${(numeric / 100)
        .toFixed(2)
        .replace('.', ',')}`
}

function numericCents(value, fallback = 0) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? Math.round(numeric) : fallback
}

function receiptRow(left, right, width = RECEIPT_WIDTH) {
    const leftText = String(left || '').trim()
    const rightText = String(right || '').trim()
    const roomForLeft = width - rightText.length - 1

    if (!rightText) {
        return `${leftText}\n`
    }

    if (roomForLeft < 8 || leftText.length > roomForLeft) {
        return `${leftText}\n${rightText.padStart(width)}\n`
    }

    return `${leftText}${' '.repeat(roomForLeft - leftText.length + 1)}${rightText}\n`
}

function isPickupOrder(order) {
    const value = String(order?.is_delivery ?? '').trim().toLowerCase()

    return value === 'retirada' ||
        value === 'pickup' ||
        value === 'balcao' ||
        value === 'balcão' ||
        value === 'false' ||
        value === '0'
}

function isTableOrder(order) {
    return String(order?.is_delivery ?? '').trim().toLowerCase() === 'mesa'
}

function paymentLabel(method) {
    const paymentMap = {
        dinheiro: 'Dinheiro',
        'pix-entrega': 'Pix na entrega',
        'trazer-maquininha': 'Maquininha',
        pix: 'Pix (pago online)',
        cartao: 'Cartao (pago online)',
    }

    return paymentMap[method] ?? method
}

async function buildReceipt(supabase, orderId, receiptConfig = readConfig(), via = 1, receiptData = null) {
    const receiptSetting = (suffix, fallback) => {
        const primaryKey = `RECEIPT_${suffix}`
        const viaKey = `RECEIPT_2_${suffix}`

        if (
            via === 2 &&
            Object.prototype.hasOwnProperty.call(receiptConfig, viaKey)
        ) {
            return receiptConfig[viaKey]
        }

        if (via === 2 && suffix === 'TITLE') {
            return 'ENTREGA'
        }

        if (Object.prototype.hasOwnProperty.call(receiptConfig, primaryKey)) {
            return receiptConfig[primaryKey]
        }

        return fallback
    }

    const receiptTitle = String(
        receiptSetting('TITLE', receiptConfig.RECEIPT_NAME_1 || 'COZINHA')
    ).trim().slice(0, 24) || 'COZINHA'
    const receiptFooter = String(receiptSetting('FOOTER_TEXT', ''))
        .trim()
        .slice(0, 120)
    const showOrderTime = receiptSetting('SHOW_ORDER_TIME', true) !== false
    const showCustomerName = receiptSetting('SHOW_CUSTOMER_NAME', true) !== false
    const showCustomerPhone = receiptSetting('SHOW_CUSTOMER_PHONE', true) !== false
    const showAddress = receiptSetting('SHOW_ADDRESS', true) !== false
    const showPayment = receiptSetting('SHOW_PAYMENT', true) !== false
    const showItemPrices = receiptSetting('SHOW_ITEM_PRICES', true) !== false
    const showSubitems = receiptSetting('SHOW_SUBITEMS', true) !== false
    const showObservations = receiptSetting('SHOW_OBSERVATIONS', true) !== false
    const showTotals = receiptSetting('SHOW_TOTALS', true) !== false

    const { order, items, subitems } = receiptData || await printerApi('receipt', { order_id: orderId })

    const subitemsByOrderItem = {}

    for (const subitem of subitems) {
        if (!subitemsByOrderItem[subitem.order_item_id]) {
            subitemsByOrderItem[subitem.order_item_id] = []
        }

        subitemsByOrderItem[subitem.order_item_id].push(subitem)
    }

    const tableOrder = isTableOrder(order)
    const pickup = isPickupOrder(order)
    const separator = '-'.repeat(RECEIPT_WIDTH)
    const scheduledDate = order.scheduled_for ? new Date(order.scheduled_for) : null
    const scheduledLabel = scheduledDate && !Number.isNaN(scheduledDate.getTime())
        ? scheduledDate.toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        })
        : null
    let text = printerStart()

    text += ESC.alignCenter
    text += ESC.boldOn + ESC.doubleSize + `${receiptTitle}\n`
    text += ESC.normalSize + ESC.boldOff
    text += ESC.alignLeft
    text += `${separator}\n`

    text += ESC.boldOn + `PEDIDO #${order.display_id}\n` + ESC.boldOff

    if (scheduledLabel) {
        text += `${separator}\n`
        text += ESC.alignCenter
        text += ESC.boldOn + ESC.doubleSize + 'AGENDADO\n'
        text += ESC.normalSize
        text += ESC.boldOn + `${pickup ? 'RETIRADA' : 'ENTREGA'}: ${scheduledLabel}\n` + ESC.boldOff
        text += ESC.alignLeft
        text += `${separator}\n`
    }

    if (showOrderTime) {
        text += `Hora: ${new Date(order.created_at).toLocaleString('pt-BR')}\n`
    }
    text += `Tipo: ${tableOrder ? 'Mesa' : pickup ? 'Retirada' : 'Entrega'}\n`

    if (tableOrder) {
        text += `Mesa: ${order.table_name_snapshot || 'Mesa'}\n`
    }

    if (showCustomerName && order.customer_name) {
        text += `Cliente: ${order.customer_name}\n`
    }

    if (showCustomerPhone && !tableOrder && order.customer_phone) {
        text += `Telefone: ${order.customer_phone}\n`
    }

    if (showAddress && !tableOrder && !pickup && order.customer_address) {
        text += 'Endereco:\n'
        text += `${order.customer_address}\n`
    }

    if (showPayment && !tableOrder && order.payment_method) {
        text += `Pagamento: ${paymentLabel(order.payment_method)}\n`
    }

    text += `${separator}\n`

    for (const item of items || []) {
        const quantity = Math.max(1, Number(item.quantity) || 1)
        const itemTotal = numericCents(
            item.total_cents,
            numericCents(item.price_cents) * quantity
        )

        text += ESC.boldOn
        text += showItemPrices
            ? receiptRow(`${quantity}x ${item.name}`, money(itemTotal))
            : `${quantity}x ${item.name}\n`
        text += ESC.boldOff

        const selectedSubitems = subitemsByOrderItem[item.id] || []

        if (showSubitems) {
            for (const selected of selectedSubitems) {
                const selectedQuantity = Math.max(1, Number(selected.quantity) || 1)
                const selectedPrice = numericCents(selected.price_cents)
                const selectedLabel = `  - ${selectedQuantity}x ${selected.name}`

                text += showItemPrices && selectedPrice > 0
                    ? receiptRow(
                        selectedLabel,
                        `+${money(selectedPrice * selectedQuantity)}`
                    )
                    : `${selectedLabel}\n`
            }
        }

        if (showObservations && item.observation) {
            text += `  OBS: ${item.observation}\n`
        }
    }

    text += `${separator}\n`

    const subtotal = numericCents(order.subtotal_cents)
    const delivery = pickup || tableOrder ? 0 : numericCents(order.delivery_cents)
    const storedDiscount = numericCents(order.coupon_discount_cents)
    const discount = storedDiscount > 0
        ? storedDiscount
        : Math.max(subtotal + delivery - numericCents(order.total_cents), 0)
    const total = numericCents(
        order.total_cents,
        subtotal + delivery - discount
    )

    if (showTotals) {
        text += receiptRow('Subtotal', money(subtotal))

        if (delivery > 0) {
            text += receiptRow('Entrega', money(delivery))
        }

        if (discount > 0) {
            text += receiptRow('Desconto', `-${money(discount)}`)
        }

        text += ESC.boldOn
        text += receiptRow('TOTAL', money(total))
        text += ESC.boldOff
    }

    if (receiptFooter) {
        text += '\n'
        text += ESC.alignCenter
        text += `${receiptFooter}\n`
        text += ESC.alignLeft
    }

    const ending = '\n\n\n' + ESC.cut
    const logoBuffer = createReceiptLogoBuffer(receiptConfig, via)

    if (!logoBuffer) {
        return text + ending
    }

    const logoPosition = normalizeReceiptLogoPosition(
        getReceiptLogoSetting(receiptConfig, via, 'LOGO_POSITION', 'top')
    )

    if (logoPosition === 'bottom') {
        return Buffer.concat([
            encodePrinterData(text + '\n'),
            logoBuffer,
            encodePrinterData(ending),
        ])
    }

    const start = printerStart()
    return Buffer.concat([
        encodePrinterData(start),
        logoBuffer,
        encodePrinterData(text.slice(start.length) + ending),
    ])
}

async function buildConfiguredReceipts(supabase, orderId, config) {
    const receiptData = await printerApi('receipt', { order_id: orderId })
    const firstReceipt = await buildReceipt(null, orderId, config, 1, receiptData)

    if (getPrintCopies(config) !== 2) {
        return [firstReceipt]
    }

    const secondReceipt = await buildReceipt(null, orderId, config, 2, receiptData)
    return [firstReceipt, secondReceipt]
}

async function startPrinterLoop() {
    if (printerLoopRunning) {
        return
    }

    const config = readConfig()

    if (!config.RESTAURANT_ID) {
        sendLog('Aguardando login...')
        return
    }

    const supabase = getSupabase()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
        sendLog('Faça login novamente para conectar a impressora.')
        requireNewLogin()
        return
    }

    printerLoopRunning = true
    stopPrinterLoop = false

    sendLog('Impressora ativa.')
    sendLog(`Modo: ${config.PRINTER_MODE}`)
    sendLog(`Restaurante: ${config.RESTAURANT_NAME || config.RESTAURANT_ID}`)

    try {
        await recoverInterruptedJobs(supabase, config)
    } catch (err) {
        sendLog(`Erro ao recuperar fila: ${err.message}`)
    }

    queueChannel = supabase
        .channel(`printer-queue-${config.RESTAURANT_ID}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'printer_queue_signals',
            filter: `restaurant_id=eq.${config.RESTAURANT_ID}`,
        }, () => wakePrinter())
        .subscribe(status => {
            if (status === 'SUBSCRIBED') wakePrinter()
        })

    while (!stopPrinterLoop) {
        let job = null
        let attempt = null
        let jobClaimed = false
        let printSent = false
        let retryDelayMs = null

        try {
            const latestConfig = readConfig()

            if (!latestConfig.RESTAURANT_ID) {
                await sleep(2000)
                continue
            }

            job = await getNextJob(supabase, latestConfig)

            if (job) {
                const previousAttempts = Number(job.attempts || 0)

                if (previousAttempts >= MAX_PRINT_ATTEMPTS) {
                    await updateJob(supabase, job.id, {
                        status: 'failed',
                        last_error:
                            job.last_error ||
                            `Falha após ${MAX_PRINT_ATTEMPTS} tentativas de impressão.`,
                    })
                    sendLog(
                        `Pedido ${job.id} excedeu ${MAX_PRINT_ATTEMPTS} tentativas. Liberando próximo pedido.`
                    )
                } else {
                    attempt = previousAttempts + 1
                    const copies = getPrintCopies(latestConfig)
                    const receipts = await withTimeout(
                        buildConfiguredReceipts(supabase, job.order_id, latestConfig),
                        RECEIPT_BUILD_TIMEOUT_MS,
                        'Tempo limite ao preparar o pedido para impressão.'
                    )

                    jobClaimed = await claimJob(supabase, job.id, attempt)

                    if (jobClaimed) {
                        sendLog(
                            `Imprimindo pedido: ${job.id} (tentativa ${attempt}/${MAX_PRINT_ATTEMPTS})${copies === 2 ? ' (2 vias)' : ''}`
                        )

                        await printConfiguredCopies(receipts, latestConfig)
                        printSent = true

                        try {
                            await updateJob(supabase, job.id, {
                                status: 'printed',
                                printed_at: new Date().toISOString(),
                                last_error: null,
                            })
                        } catch (statusError) {
                            sendLog(
                                `Impresso, mas não foi possível confirmar o status do pedido ${job.id}: ${statusError.message}`
                            )
                        }

                        sendLog(`Impresso: ${job.id}${copies === 2 ? ' (2 vias)' : ''}`)
                    }
                }
            }
        } catch (err) {
            if (job?.id && !printSent) {
                const currentAttempt =
                    attempt ?? Number(job.attempts || 0) + 1
                const retryable = err?.printRetryable !== false
                const exhausted =
                    !retryable || currentAttempt >= MAX_PRINT_ATTEMPTS

                try {
                    const failurePatch = {
                        status: exhausted ? 'failed' : 'queued',
                        last_error: String(err.message || err),
                    }

                    if (jobClaimed) {
                        await updateJob(supabase, job.id, failurePatch)
                    } else {
                        await updateQueuedJobFailure(
                            supabase,
                            job.id,
                            currentAttempt,
                            failurePatch
                        )
                    }

                    if (!exhausted && currentAttempt === MAX_PRINT_ATTEMPTS - 1) {
                        retryDelayMs = FINAL_PRINT_RETRY_DELAY_MS
                        sendLog(
                            `Falha ao imprimir ${job.id} (tentativa ${currentAttempt}/${MAX_PRINT_ATTEMPTS}). Última tentativa em 30 segundos.`
                        )
                    } else if (exhausted) {
                        sendLog(
                            `Pedido ${job.id} falhou após ${currentAttempt} tentativa(s). Liberando próximo pedido.`
                        )
                    }
                } catch (jobError) {
                    sendLog(`Erro ao liberar pedido ${job.id}: ${jobError.message}`)
                }
            }

            sendLog(`Erro: ${err.message}`)
        }

        if (retryDelayMs !== null) {
            // Preserve the existing delayed final retry even if Realtime signals.
            await sleep(retryDelayMs)
        } else if (job && !stopPrinterLoop) {
            // Drain an existing backlog immediately; 60s polling is only for idle printers.
            await sleep(1000)
        } else {
            await waitForPrinterWake(60000)
        }
    }

    if (queueChannel) {
        await supabase.removeChannel(queueChannel)
        queueChannel = null
    }
    printerLoopRunning = false
}

function stopLoop() {
    stopPrinterLoop = true
    wakePrinter()
    if (queueChannel) {
        getSupabase().removeChannel(queueChannel).catch(() => {})
        queueChannel = null
    }
}

async function testPrint(config) {
    const text =
        printerStart() +
        ESC.boldOn +
        'TESTE IMENU\n' +
        ESC.boldOff +
        `Modo: ${config.PRINTER_MODE}\n` +
        `Hora: ${new Date().toLocaleString('pt-BR')}\n\n\n` +
        ESC.cut

    await printConfiguredCopies(text, config)
}

async function saveRestaurantForUser(supabase, user, fallbackEmail = '') {
    if (!user?.id) {
        throw new Error('Usuário inválido.')
    }

    const { data: restaurant, error: restaurantError } = await supabase
        .from('restaurants')
        .select('id, name')
        .eq('user_id', user.id)
        .limit(1)
        .single()

    if (restaurantError) throw restaurantError

    const currentConfig = readConfig()
    const newConfig = {
        ...currentConfig,
        RESTAURANT_ID: restaurant.id,
        RESTAURANT_NAME: restaurant.name || '',
        LOGGED_IN_EMAIL: user.email || fallbackEmail,
    }

    saveConfig(newConfig)

    return {
        user: {
            id: user.id,
            email: user.email,
        },
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name || '',
    }
}

async function loginAndGetRestaurant(email, password) {
    const supabase = getSupabase(false)

    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
    })

    if (loginError) throw loginError

    return await saveRestaurantForUser(supabase, loginData.user, email)
}

function writeGoogleAuthResponse(response, ok) {
    if (!response || response.writableEnded) return

    response.writeHead(ok ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
    })
    response.end(`<!doctype html>
<html lang="pt-BR">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>iMenu Impressora</title>
</head>
<body style="font-family:Arial,sans-serif;padding:40px;color:#111827">
    <h1>${ok ? 'Login concluído' : 'Não foi possível entrar'}</h1>
    <p>${ok
        ? 'Você pode fechar esta aba e voltar ao iMenu Impressora.'
        : 'Volte ao iMenu Impressora e tente novamente.'}</p>
</body>
</html>`)
}

async function loginWithGoogleAndGetRestaurant() {
    if (googleLoginInProgress) {
        throw new Error('Um login com Google já está em andamento.')
    }

    googleLoginInProgress = true
    let callbackServer = null
    let timeout = null
    let callbackResponse = null

    try {
        const supabase = getSupabase(false, {
            flowType: 'pkce',
            storage: createMemoryAuthStorage(),
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        })

        callbackServer = http.createServer()

        await new Promise((resolve, reject) => {
            const handleError = error => {
                callbackServer.off('listening', handleListening)
                reject(error)
            }
            const handleListening = () => {
                callbackServer.off('error', handleError)
                resolve()
            }

            callbackServer.once('error', handleError)
            callbackServer.once('listening', handleListening)
            callbackServer.listen(GOOGLE_AUTH_CALLBACK_PORT, GOOGLE_AUTH_CALLBACK_HOST)
        })

        const callbackPromise = new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
                reject(new Error('Tempo limite do login com Google excedido.'))
            }, GOOGLE_AUTH_TIMEOUT_MS)

            callbackServer.on('request', (request, response) => {
                let requestUrl

                try {
                    requestUrl = new URL(request.url, GOOGLE_AUTH_CALLBACK_URL)
                } catch {
                    response.writeHead(400)
                    response.end()
                    return
                }

                if (requestUrl.pathname !== GOOGLE_AUTH_CALLBACK_PATH) {
                    response.writeHead(404)
                    response.end()
                    return
                }

                const callbackError =
                    requestUrl.searchParams.get('error_description') ||
                    requestUrl.searchParams.get('error')

                if (callbackError) {
                    writeGoogleAuthResponse(response, false)
                    reject(new Error(callbackError))
                    return
                }

                const code = requestUrl.searchParams.get('code')

                if (!code) {
                    writeGoogleAuthResponse(response, false)
                    reject(new Error('O Google não retornou um código de autenticação.'))
                    return
                }

                callbackResponse = response
                resolve(code)
            })
        })

        const { data: oauthData, error: oauthError } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: GOOGLE_AUTH_CALLBACK_URL,
                skipBrowserRedirect: true,
            },
        })

        if (oauthError) throw oauthError
        if (!oauthData?.url) {
            throw new Error('Não foi possível abrir o login com Google.')
        }

        await shell.openExternal(oauthData.url)

        const code = await callbackPromise
        const { data: sessionData, error: sessionError } =
            await supabase.auth.exchangeCodeForSession(code)

        if (sessionError) throw sessionError
        if (!sessionData?.user) {
            throw new Error('Não foi possível recuperar o usuário do Google.')
        }

        const { error: persistedSessionError } = await getSupabase().auth.setSession({
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
        })
        if (persistedSessionError) throw persistedSessionError

        const result = await saveRestaurantForUser(
            supabase,
            sessionData.user,
            sessionData.user.email || ''
        )

        writeGoogleAuthResponse(callbackResponse, true)
        return result
    } catch (error) {
        writeGoogleAuthResponse(callbackResponse, false)

        if (error?.code === 'EADDRINUSE') {
            throw new Error('A porta local usada pelo login com Google está ocupada. Feche outro iMenu Impressora e tente novamente.')
        }

        throw error
    } finally {
        if (timeout) clearTimeout(timeout)

        if (callbackServer?.listening) {
            await new Promise(resolve => callbackServer.close(resolve))
        }

        googleLoginInProgress = false
    }
}

function addVersionToHelpMenu() {
    const menu = Menu.getApplicationMenu()
    if (!menu) return

    const helpItem = menu.items.find(item =>
        item.role === 'help' || String(item.label || '').toLowerCase() === 'help'
    )

    if (!helpItem?.submenu) return

    const versionLabel = `Versão ${app.getVersion()}`
    const alreadyAdded = helpItem.submenu.items.some(item => item.label === versionLabel)

    if (!alreadyAdded) {
        helpItem.submenu.append(new MenuItem({
            label: versionLabel,
            enabled: false,
        }))
        Menu.setApplicationMenu(menu)
    }
}

function showMainWindow() {
    if (!win || win.isDestroyed()) return

    win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
}

async function createTray() {
    if (tray) return tray

    const appIconPath = path.join(__dirname, 'favicon.png')
    let trayIcon = appIconPath

    if (!fs.existsSync(appIconPath)) {
        trayIcon = await app.getFileIcon(process.execPath)
    }

    tray = new Tray(trayIcon)
    tray.setToolTip('iMenu Impressora')
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: 'Abrir iMenu Impressora',
            click: showMainWindow,
        },
        { type: 'separator' },
        {
            label: 'Fechar Aplicativo',
            click: quitApplication,
        },
    ]))
    tray.on('click', showMainWindow)
    tray.on('double-click', showMainWindow)

    return tray
}

function quitApplication() {
    if (forceQuit) return

    forceQuit = true
    app.quit()
}

function createWindow() {
    const appIconPath = path.join(__dirname, 'favicon.png')

    win = new BrowserWindow({
        width: 1080,
        height: 760,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: '#f7f8fa',
        icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
        },
    })

    win.loadFile('index.html')

    win.on('close', event => {
        if (forceQuit || !tray) return

        event.preventDefault()
        win.hide()
    })

    win.webContents.once('did-finish-load', () => {
        publishUpdateStatus()
        const config = readConfig()

        if (config.RESTAURANT_ID) {
            isAuthenticated().then(authenticated => {
                if (!authenticated) {
                    requireNewLogin()
                    return
                }
                startPrinterLoop().catch(err => {
                    printerLoopRunning = false
                    sendLog(`Fatal: ${err.message}`)
                })
            }).catch(err => sendLog(`Erro de autenticação: ${err.message}`))
        }
    })
}

app.whenReady().then(async () => {
    if (process.platform === 'win32' && app.isPackaged) {
        try {
            app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })
        } catch (error) {
            sendLog(`Não foi possível ativar a inicialização com o Windows: ${error.message}`)
        }
    }

    await createTray()
    createWindow()
    addVersionToHelpMenu()
    scheduleUpdateChecks()
})

app.on('before-quit', () => {
    forceQuit = true
})

app.on('will-quit', () => {
    if (tray) {
        tray.destroy()
        tray = null
    }
})

ipcMain.handle('config:get', () => {
    return readConfig()
})

ipcMain.handle('auth:status', async () => {
    return await isAuthenticated()
})

ipcMain.handle('receipt-logo:select', async () => {
    const result = await dialog.showOpenDialog(win, {
        title: 'Selecionar logo da comanda',
        properties: ['openFile'],
        filters: [
            { name: 'Imagens', extensions: ['png', 'jpg', 'jpeg'] },
        ],
    })

    if (result.canceled || !result.filePaths[0]) {
        return { canceled: true }
    }

    const selectedPath = result.filePaths[0]
    const preview = getReceiptLogoPreviewPayload(selectedPath)
    if (!preview.exists) {
        throw new Error('Não foi possível abrir esta imagem.')
    }

    return {
        canceled: false,
        path: selectedPath,
        fileName: preview.fileName,
        previewDataUrl: preview.previewDataUrl,
    }
})

ipcMain.handle('receipt-logo:preview', (_, imagePath) => {
    return getReceiptLogoPreviewPayload(imagePath)
})

ipcMain.handle('update:get-status', () => {
    return updateState
})

ipcMain.handle('update:check', async () => {
    return await checkForAppUpdate()
})

ipcMain.handle('update:install', () => {
    return installPendingUpdate()
})

ipcMain.handle('support:open', async () => {
    await shell.openExternal(SUPPORT_WHATSAPP_URL)
    return { ok: true }
})

ipcMain.handle('app:quit', () => {
    quitApplication()
    return { ok: true }
})

ipcMain.handle('config:save', async (_, config) => {
    const currentConfig = readConfig()

    const newConfig = {
        ...currentConfig,
        ...config,
    }

    saveConfig(newConfig)

    startPrinterLoop().catch(err => {
        printerLoopRunning = false
        sendLog(`Fatal: ${err.message}`)
    })

    return { ok: true }
})

ipcMain.handle('printers:detect', async () => {
    return await detectPrinters()
})

ipcMain.handle('printer:test', async (_, config) => {
    const currentConfig = readConfig()

    const testConfig = {
        ...currentConfig,
        ...config,
    }

    await testPrint(testConfig)
    return { ok: true }
})

ipcMain.handle('orders:history', async () => {
    return await getRecentPrintHistory()
})

ipcMain.handle('orders:reprint', async (_, orderId) => {
    return await reprintOrder(orderId)
})

ipcMain.handle('auth:login', async (_, { email, password }) => {
    const result = await loginAndGetRestaurant(email, password)

    startPrinterLoop().catch(err => {
        printerLoopRunning = false
        sendLog(`Fatal: ${err.message}`)
    })

    return result
})

ipcMain.handle('auth:google', async () => {
    const result = await loginWithGoogleAndGetRestaurant()

    startPrinterLoop().catch(err => {
        printerLoopRunning = false
        sendLog(`Fatal: ${err.message}`)
    })

    return result
})

ipcMain.handle('auth:logout', async () => {
    stopLoop()
    await getSupabase().auth.signOut()
    const currentConfig = readConfig()

    saveConfig({
        ...currentConfig,
        RESTAURANT_ID: '',
        RESTAURANT_NAME: '',
        LOGGED_IN_EMAIL: '',
    })

    return { ok: true }
})

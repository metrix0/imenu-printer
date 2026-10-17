const WebSocket = require('ws')
const { app, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeImage, shell, Tray, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const { exec, execFile, spawn } = require('child_process')
const { createHash } = require('crypto')
const { createClient } = require('@supabase/supabase-js')
const { SerialPort } = require('serialport')
const iconv = require('iconv-lite')

const baseDir = app.getPath('userData')
const configPath = path.join(baseDir, 'config.json')

const PRINTER_CONFIG_URL = process.env.IMENU_PRINTER_CONFIG_URL || 'https://www.imenuapp.com.br/api/printer/config'
const connectionConfigPath = path.join(baseDir, 'connection-config.json')
let connectionConfig = null
let remoteUpdatePolicy = null
let mandatoryUpdateWaiting = false
let activePrintOperations = 0
let activePrinterCycle = false
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

const RECEIPT_DEFAULT_PAPER_WIDTH = '58'
const RECEIPT_PAPER_COLUMNS = {
    '58': 32,
    '80': 48,
}
const RECEIPT_LOGO_MAX_WIDTH = 320
const RECEIPT_LOGO_MAX_HEIGHT = 160
const RECEIPT_LOGO_THRESHOLD = 180
const RECEIPT_LOGO_SIZES = {
    small: { width: 160, height: 80 },
    medium: { width: 240, height: 120 },
    large: { width: RECEIPT_LOGO_MAX_WIDTH, height: RECEIPT_LOGO_MAX_HEIGHT },
}
const MAX_PRINT_ATTEMPTS = 5
const LEGACY_MAX_PRINT_ATTEMPTS = 3
const PRINT_RETRY_DELAYS_MS = [1000, 30 * 1000, 90 * 1000, 180 * 1000]
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
    doubleHeight: '\x1D\x21\x10',
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

function validPrinterConnection(data) {
    if (!data || typeof data.supabaseUrl !== 'string' || typeof data.supabaseAnonKey !== 'string') return null
    try {
        const parsed = new URL(data.supabaseUrl)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
        const parts = data.supabaseAnonKey.split('.')
        const isPublic = data.supabaseAnonKey.startsWith('sb_publishable_') ||
            (parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon')
        if (!isPublic) return null
        return { supabaseUrl: parsed.origin + parsed.pathname.replace(/\/+$/, ''), supabaseAnonKey: data.supabaseAnonKey }
    } catch {
        return null
    }
}

function requiredPrinterUpdate() {
    return Boolean(remoteUpdatePolicy?.forceUpdate &&
        /^\d+\.\d+\.\d+$/.test(remoteUpdatePolicy.minimumVersion || '') &&
        compareVersions(app.getVersion(), remoteUpdatePolicy.minimumVersion) < 0)
}

async function refreshPrinterConnection() {
    const url = PRINTER_CONFIG_URL + (isLegacyBuild() ? '?edition=legacy' : '')
    const data = await withTimeout(requestJson(url), 6000, 'Tempo limite ao buscar configuração da impressora.')
    const validated = validPrinterConnection(data)
    if (!validated) throw new Error('Configuração pública inválida.')

    // Existing sessions continue with their connection until the next launch.
    if (!connectionConfig) connectionConfig = validated
    const policy = data.updates
    remoteUpdatePolicy = policy?.forceUpdate === true &&
        typeof policy.latestVersion === 'string' && /^\d+\.\d+\.\d+$/.test(policy.latestVersion) &&
        typeof policy.minimumVersion === 'string' && /^\d+\.\d+\.\d+$/.test(policy.minimumVersion) &&
        compareVersions(policy.minimumVersion, policy.latestVersion) <= 0
        ? { latestVersion: policy.latestVersion, minimumVersion: policy.minimumVersion,
            forceUpdate: true, downloadUrl: policy.downloadUrl }
        : null

    try {
        fs.mkdirSync(baseDir, { recursive: true })
        fs.writeFileSync(connectionConfigPath, JSON.stringify(validated), { mode: 0o600 })
    } catch (error) {
        sendLog('Não foi possível guardar a configuração pública: ' + error.message)
    }
}

async function initializePrinterConnection() {
    try {
        await refreshPrinterConnection()
    } catch (error) {
        try {
            connectionConfig = validPrinterConnection(JSON.parse(fs.readFileSync(connectionConfigPath, 'utf8')))
        } catch {}
        if (!connectionConfig) {
            throw new Error('Não foi possível carregar a configuração da impressora. Verifique a conexão e tente novamente.')
        }
        sendLog('Servidor de configuração indisponível. Usando a última configuração pública salva.')
    }
}

async function verifyUpdateChecksum(filePath, digest) {
    const expected = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || ''))?.[1]
    if (!expected) return false
    const actual = await new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
    })
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        try { fs.unlinkSync(filePath) } catch {}
        throw new Error('O instalador baixado falhou na verificação de integridade.')
    }
    return true
}

function installRequiredUpdateIfIdle() {
    if (!mandatoryUpdateWaiting || activePrintOperations > 0 || activePrinterCycle ||
        updateInstallScheduled || !pendingUpdate?.installerPath) return
    installPendingUpdate()
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
        await refreshPrinterConnection().catch(() => {})
        const release = await requestJson(
            `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
        )
        const version = String(release?.tag_name || '').replace(/^v/i, '').trim()

        if (!version || compareVersions(version, app.getVersion()) <= 0) {
            if (requiredPrinterUpdate()) throw new Error('Versão obrigatória ainda não publicada.')
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
        const mandatory = requiredPrinterUpdate()
        if (mandatory && compareVersions(version, remoteUpdatePolicy.minimumVersion) < 0) {
            throw new Error('Instalador anterior à versão mínima exigida.')
        }
        if (mandatory && !/^sha256:[0-9a-f]{64}$/i.test(String(installer.digest || ''))) {
            throw new Error('Instalador obrigatório sem hash SHA-256 verificável.')
        }

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

        await verifyUpdateChecksum(installerPath, installer.digest)
        pendingUpdate = { version, installerPath }
        mandatoryUpdateWaiting = mandatory
        const ready = publishUpdateStatus({
            status: 'ready',
            availableVersion: version,
            progress: 100,
            message: mandatory ? 'Atualização obrigatória pronta. Instalando quando a impressora estiver livre...' : `Versão ${version} pronta.`,
        })
        installRequiredUpdateIfIdle()
        return ready
    } catch (error) {
        return publishUpdateStatus({
            status: 'error',
            progress: null,
            message: requiredPrinterUpdate() ? 'Atualização obrigatória indisponível. A impressão continuará funcionando.' : 'Não foi possível verificar atualizações agora.',
        })
    } finally {
        updateCheckInProgress = false
    }
}

function installPendingUpdate() {
    if (activePrinterCycle || activePrintOperations > 0) {
        return { ok: false, status: publishUpdateStatus({ status: 'ready', message: 'Aguardando terminar a impressão em andamento.' }) }
    }
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
        stopLoop()

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
        RECEIPT_SHOW_ORDER_NUMBER: true,
        RECEIPT_SHOW_ORDER_TIME: true,
        RECEIPT_SHOW_CUSTOMER_NAME: true,
        RECEIPT_SHOW_CUSTOMER_PHONE: true,
        RECEIPT_SHOW_ADDRESS: true,
        RECEIPT_SHOW_PAYMENT: true,
        RECEIPT_SHOW_ITEM_PRICES: true,
        RECEIPT_SHOW_SUBITEMS: true,
        RECEIPT_SHOW_OBSERVATIONS: true,
        RECEIPT_SHOW_TOTALS: true,
        RECEIPT_PAPER_WIDTH: RECEIPT_DEFAULT_PAPER_WIDTH,
        RECEIPT_TEXT_SIZE: 'normal',
        RECEIPT_ORDER_SIZE: 'extra',
        RECEIPT_ITEM_SIZE: 'large',
        RECEIPT_TOTAL_SIZE: 'extra',
        RECEIPT_SPACING: 'normal',
        RECEIPT_SHOW_LOGO: false,
        RECEIPT_LOGO_PATH: '',
        RECEIPT_LOGO_POSITION: 'top',
        RECEIPT_LOGO_SIZE: 'large',

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

    if (!connectionConfig) throw new Error('Configuração pública da impressora indisponível.')
    const client = createClient(connectionConfig.supabaseUrl, connectionConfig.supabaseAnonKey, {
        auth: {
            storage: authStorage,
            storageKey: 'sb-mjogdsnxbwhbqcoijrwt-auth-token',
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


function runPrinterDiscoveryCommand(script) {
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 },
            (error, stdout) => resolve(error ? [] : String(stdout || '').split(/\r?\n/).filter(Boolean))
        )
    })
}

function decodeWindowsName(encoded) {
    try { return Buffer.from(encoded, 'base64').toString('utf8').trim() } catch { return '' }
}

function listWindowsPrintersPrimary() {
    return new Promise(resolve => {
        const cmd = 'powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName | ConvertTo-Json -Compress"'

        exec(cmd, { timeout: 10000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
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

async function listWindowsPrinters() {
    const primary = await listWindowsPrintersPrimary()
    if (primary.length) return primary

    // Windows printer discovery fallback for unavailable or unsuccessful Get-Printer.
    const lines = await runPrinterDiscoveryCommand(
        "$ErrorActionPreference='SilentlyContinue'; " +
        "Get-WmiObject Win32_Printer | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Name)) + '|' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.PortName)) }"
    )
    return lines.map(line => {
        const [name, portName] = line.split('|')
        const decoded = decodeWindowsName(name)
        return decoded ? { name: decoded, portName: decodeWindowsName(portName), type: 'windows-printer' } : null
    }).filter(Boolean)
}

async function listPairedBluetoothDevices() {
    // Device enumeration is informational: pairing does not imply a usable print connection.
    const lines = await runPrinterDiscoveryCommand(
        "$ErrorActionPreference='SilentlyContinue'; " +
        "Get-WmiObject Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'BTHENUM*DEV_*' -or $_.PNPDeviceID -like 'BTHLEDEVICE*' } | " +
        "ForEach-Object { if ($_.Name) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Name)) } }"
    )
    return [...new Set(lines.map(decodeWindowsName).filter(Boolean))]
}

function printerNameKey(name) {
    return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isVirtualWindowsPrinter(name) {
    return /^(microsoft print to pdf|microsoft xps document writer|fax|onenote|send to onenote|adobe pdf)$/i.test(String(name || '').trim())
}

function buildDiscoveredPrinters(windowsPrinters, comPorts, pairedBluetooth) {
    const devices = []
    const recognized = new Set()
    const detectedPorts = [...comPorts]
    const nameMatches = (a, b) => {
        const left = printerNameKey(a)
        const right = printerNameKey(b)
        return Boolean(left && right && (left === right ||
            (left.length >= 6 && right.includes(left)) ||
            (right.length >= 6 && left.includes(right))))
    }

    for (const printer of windowsPrinters) {
        if (isVirtualWindowsPrinter(printer.name)) continue
        devices.push({
            id: 'windows:' + printer.name,
            name: printer.name,
            detail: 'Instalada no Windows — USB, Bluetooth ou rede',
            ready: true,
            mode: 'usb',
            printerName: printer.name,
        })
    }

    // If Windows already has a queue for the same serial port, prefer the queue.
    const serialPorts = detectedPorts.filter(port =>
        !windowsPrinters.some(p =>
            String(p.portName || '').split(',').some(n =>
                normalizeComPortName(n) === normalizeComPortName(port.path)
            )
        )
    )
    const unmatchedPaired = pairedBluetooth.filter(name =>
        !windowsPrinters.some(p => nameMatches(name, p.name))
    )

    for (const port of serialPorts) {
        const friendly = String(port.friendlyName || port.manufacturer || '').trim()
        const match = unmatchedPaired.find(name => nameMatches(friendly, name))
        // Generic COM ports are not necessarily printers (for example COM1).
        // Keep them available in advanced settings, not the one-click list.
        if (!match && !/bluetooth|printer|impressora|thermal|receipt|pos/i.test(friendly)) continue
        if (match) recognized.add(match)
        devices.push({
            id: 'serial:' + port.path,
            name: match || (friendly && !/^standard serial over bluetooth link/i.test(friendly)
                ? friendly : 'Dispositivo serial ' + port.path),
            detail: port.path + (match ? ' — conexão Bluetooth disponível' : ' — testar para confirmar'),
            ready: true,
            mode: 'bluetooth',
            comPort: port.path,
        })
    }

    // A single explicitly identified Bluetooth serial port can be offered as a
    // probable match. The test print, not pairing, confirms the actual route.
    const candidates = unmatchedPaired.filter(name => !recognized.has(name))
    const genericBluetoothPorts = devices.filter(d => d.mode === 'bluetooth' &&
        /bluetooth/i.test(String(serialPorts.find(p => p.path === d.comPort)?.friendlyName || '')))
    if (candidates.length === 1 && genericBluetoothPorts.length === 1) {
        genericBluetoothPorts[0].name = candidates[0]
        genericBluetoothPorts[0].detail += ' (conexão provável)'
        recognized.add(candidates[0])
    }

    for (const name of unmatchedPaired) {
        if (recognized.has(name)) continue
        devices.push({
            id: 'paired:' + name,
            name,
            detail: 'Bluetooth encontrado — ainda sem conexão de impressão',
            ready: false,
            mode: null,
        })
    }
    return devices
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
    const [detectedWindowsPrinters, serialPorts, pairedBluetooth] = await Promise.all([
        listWindowsPrinters(),
        listComPorts().catch(() => []),
        listPairedBluetoothDevices(),
    ])
    const detectedComPorts = serialPorts.map(port => {
        const portName = normalizeComPortName(port.path)
        const matchingPrinter = detectedWindowsPrinters.find(
            printer => String(printer.portName || '').split(',').some(name =>
                normalizeComPortName(name) === portName
            )
        )
        return matchingPrinter ? { ...port, friendlyName: matchingPrinter.name } : port
    })
    const devices = buildDiscoveredPrinters(detectedWindowsPrinters, detectedComPorts, pairedBluetooth)

    const comPorts = putSavedSelectionFirst(
        detectedComPorts, config.PRINTER_COM_PORT, 'path',
        savedPath => ({
            path: savedPath, manufacturer: '',
            friendlyName: 'Salva anteriormente (não detectada agora)',
            serialNumber: '', type: 'bluetooth-or-serial',
        })
    )
    const windowsPrinters = putSavedSelectionFirst(
        detectedWindowsPrinters, config.PRINTER_NAME, 'name',
        savedName => ({ name: savedName, type: 'windows-printer' })
    )
    return { devices, comPorts, windowsPrinters }
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

function normalizeReceiptLogoSize(value) {
    const normalized = String(value || '').trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(RECEIPT_LOGO_SIZES, normalized)
        ? normalized
        : 'large'
}

function loadMonochromeReceiptLogo(imagePath, logoSize = 'large') {
    const normalizedPath = String(imagePath || '').trim()
    if (!normalizedPath || !fs.existsSync(normalizedPath)) return null

    const normalizedSize = normalizeReceiptLogoSize(logoSize)
    const target = RECEIPT_LOGO_SIZES[normalizedSize]
    const stats = fs.statSync(normalizedPath)
    const cacheId = `${normalizedPath}:${normalizedSize}`
    const cacheKey = `${normalizedPath}:${stats.mtimeMs}:${stats.size}:${normalizedSize}`
    const cached = receiptLogoCache.get(cacheId)
    if (cached?.cacheKey === cacheKey) return cached

    const source = nativeImage.createFromPath(normalizedPath)
    if (source.isEmpty()) return null

    const sourceSize = source.getSize()
    if (sourceSize.width < 1 || sourceSize.height < 1) return null

    const scale = Math.min(
        1,
        target.width / sourceSize.width,
        target.height / sourceSize.height
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

    receiptLogoCache.set(cacheId, processed)
    return processed
}

function createReceiptLogoRasterBuffer(imagePath, logoSize = 'large') {
    const processed = loadMonochromeReceiptLogo(imagePath, logoSize)
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

    const logoSize = normalizeReceiptLogoSize(
        getReceiptLogoSetting(config, via, 'LOGO_SIZE', 'large')
    )

    return createReceiptLogoRasterBuffer(imagePath, logoSize)
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
    activePrintOperations += 1
    try {
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
    } finally {
        activePrintOperations -= 1
        installRequiredUpdateIfIdle()
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
    return response.job
        ? { ...response.job, max_print_attempts: response.max_print_attempts }
        : null
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

async function getRecentPrintHistory(limit = 50) {
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

function receiptRow(
    left,
    right,
    width = RECEIPT_PAPER_COLUMNS[RECEIPT_DEFAULT_PAPER_WIDTH]
) {
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

function normalizeReceiptTextSize(value, fallback = 'normal', allowExtra = false) {
    const normalized = String(value || '').trim().toLowerCase()
    const allowed = allowExtra
        ? new Set(['normal', 'large', 'extra'])
        : new Set(['normal', 'large'])
    return allowed.has(normalized) ? normalized : fallback
}

function receiptTextSizeCommand(size) {
    if (size === 'extra') return ESC.doubleSize
    if (size === 'large') return ESC.doubleHeight
    return ESC.normalSize
}

function normalizeReceiptPaperWidth(value) {
    return String(value || '') === '80' ? '80' : RECEIPT_DEFAULT_PAPER_WIDTH
}

function receiptPaperColumns(value) {
    return RECEIPT_PAPER_COLUMNS[normalizeReceiptPaperWidth(value)]
}

function receiptTextWidth(size, paperColumns) {
    return size === 'extra' ? Math.floor(paperColumns / 2) : paperColumns
}

function receiptDateTimeLabel(value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''

    const datePart = date.toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    })
    const timePart = date.toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
    })

    return `${datePart} às ${timePart}`
}

function receiptPaymentLabel(method) {
    const paymentMap = {
        pix: 'Pix',
        cartao: 'Cartao',
        dinheiro: 'Dinheiro',
        'pix-entrega': 'Pix na entrega',
        'trazer-maquininha': 'Maquininha',
    }

    return paymentMap[method] ?? paymentLabel(method)
}

function normalizeReceiptSpacing(value) {
    const normalized = String(value || '').trim().toLowerCase()
    return ['compact', 'normal', 'spacious'].includes(normalized)
        ? normalized
        : 'normal'
}

function receiptSectionGap(spacing) {
    if (spacing === 'spacious') return '\n\n'
    if (spacing === 'normal') return '\n'
    return ''
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

    const rawReceiptTitle = String(
        receiptSetting('TITLE', receiptConfig.RECEIPT_NAME_1 || 'COZINHA')
    ).trim().slice(0, 24)
    const receiptTitle = rawReceiptTitle
    const receiptFooter = String(receiptSetting('FOOTER_TEXT', ''))
        .trim()
        .slice(0, 120)
    const showOrderNumber = receiptSetting('SHOW_ORDER_NUMBER', true) !== false
    const showOrderTime = receiptSetting('SHOW_ORDER_TIME', true) !== false
    const showCustomerName = receiptSetting('SHOW_CUSTOMER_NAME', true) !== false
    const showCustomerPhone = receiptSetting('SHOW_CUSTOMER_PHONE', true) !== false
    const showAddress = receiptSetting('SHOW_ADDRESS', true) !== false
    const showPayment = receiptSetting('SHOW_PAYMENT', true) !== false
    const showItemPrices = receiptSetting('SHOW_ITEM_PRICES', true) !== false
    const showSubitems = receiptSetting('SHOW_SUBITEMS', true) !== false
    const showObservations = receiptSetting('SHOW_OBSERVATIONS', true) !== false
    const showTotals = receiptSetting('SHOW_TOTALS', true) !== false
    const paperWidth = normalizeReceiptPaperWidth(
        receiptConfig.RECEIPT_PAPER_WIDTH
    )
    const paperColumns = receiptPaperColumns(paperWidth)
    const textSize = normalizeReceiptTextSize(
        receiptSetting('TEXT_SIZE', 'normal'),
        'normal'
    )
    const orderSize = normalizeReceiptTextSize(
        receiptSetting('ORDER_SIZE', 'extra'),
        'extra',
        true
    )
    const itemSize = normalizeReceiptTextSize(
        receiptSetting('ITEM_SIZE', 'large'),
        'large'
    )
    const totalSize = normalizeReceiptTextSize(
        receiptSetting('TOTAL_SIZE', 'extra'),
        'extra',
        true
    )
    const receiptSpacing = normalizeReceiptSpacing(
        receiptSetting('SPACING', 'normal')
    )
    const sectionGap = receiptSectionGap(receiptSpacing)

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
    // Keep separators and typography on ESC/POS text commands only.
    // This preserves compatibility with the same printers already supported.
    const separator = '_'.repeat(paperColumns)
    const orderDateTime = receiptDateTimeLabel(order.created_at)
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
    const receiptItems = items || []
    let text = printerStart()

    if (receiptTitle) {
        text += ESC.alignCenter
        text += ESC.boldOn + ESC.normalSize + `${receiptTitle}\n`
        text += ESC.boldOff + ESC.alignLeft
        text += sectionGap
    }

    if (showOrderNumber) {
        text += ESC.alignCenter
        text += ESC.boldOn + receiptTextSizeCommand(orderSize)
        text += `PEDIDO #${order.display_id}\n`
        text += ESC.normalSize + ESC.boldOff
        text += ESC.alignLeft
    }

    if (scheduledLabel) {
        text += `${separator}\n`
        text += ESC.alignCenter
        text += ESC.boldOn + receiptTextSizeCommand(orderSize) + 'AGENDADO\n'
        text += ESC.normalSize
        text += ESC.boldOn + `${pickup ? 'RETIRADA' : 'ENTREGA'}: ${scheduledLabel}\n` + ESC.boldOff
        text += ESC.alignLeft
        text += `${separator}\n`
        text += sectionGap
    }

    text += receiptTextSizeCommand(textSize)

    if (tableOrder) {
        text += 'Tipo: Mesa\n'
        text += `Mesa: ${order.table_name_snapshot || 'Mesa'}\n`
    } else if (pickup) {
        text += 'Tipo: Retirada\n'
    }

    if (showCustomerName && order.customer_name) {
        text += ESC.normalSize
        text += ESC.boldOn + ESC.doubleHeight
        text += `${order.customer_name}\n`
        text += ESC.normalSize + ESC.boldOff
        text += receiptTextSizeCommand(textSize)
    }

    if (showCustomerPhone && !tableOrder && order.customer_phone) {
        text += `${order.customer_phone}\n`
    }

    if (showAddress && !tableOrder && !pickup && order.customer_address) {
        text += `${order.customer_address}\n`
    }

    text += ESC.normalSize
    text += sectionGap
    text += `${separator}\n`
    text += sectionGap

    for (const item of receiptItems) {
        const quantity = Math.max(1, Number(item.quantity) || 1)
        const itemTotal = numericCents(
            item.total_cents,
            numericCents(item.price_cents) * quantity
        )

        text += ESC.boldOn + receiptTextSizeCommand(itemSize)
        text += showItemPrices
            ? receiptRow(
                `${quantity}x ${item.name}`,
                money(itemTotal),
                receiptTextWidth(itemSize, paperColumns)
            )
            : `${quantity}x ${item.name}\n`
        text += ESC.normalSize + ESC.boldOff

        const selectedSubitems = subitemsByOrderItem[item.id] || []

        if (showSubitems) {
            text += receiptTextSizeCommand(textSize)
            for (const selected of selectedSubitems) {
                const selectedQuantity = Math.max(1, Number(selected.quantity) || 1)
                const selectedPrice = numericCents(selected.price_cents)
                const selectedLabel = `   ${selectedQuantity}x ${selected.name}`

                text += showItemPrices && selectedPrice > 0
                    ? receiptRow(
                        selectedLabel,
                        `+${money(selectedPrice * selectedQuantity)}`,
                        receiptTextWidth(textSize, paperColumns)
                    )
                    : `${selectedLabel}\n`
            }
            text += ESC.normalSize
        }

        if (showObservations && item.observation) {
            text += ESC.boldOn + receiptTextSizeCommand(textSize)
            text += `   OBS: ${item.observation}\n`
            text += ESC.normalSize + ESC.boldOff
        }
    }

    text += `${separator}\n`
    text += sectionGap

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
        text += receiptTextSizeCommand(textSize)
        text += receiptRow(
            'Subtotal',
            money(subtotal),
            receiptTextWidth(textSize, paperColumns)
        )

        if (delivery > 0) {
            text += receiptRow(
                'Entrega',
                money(delivery),
                receiptTextWidth(textSize, paperColumns)
            )
        }

        if (discount > 0) {
            text += receiptRow(
                'Desconto',
                `-${money(discount)}`,
                receiptTextWidth(textSize, paperColumns)
            )
        }

        text += ESC.normalSize
        text += sectionGap

        const requestedTotalWidth = receiptTextWidth(totalSize, paperColumns)
        const totalText = money(total)
        const resolvedTotalSize =
            totalSize === 'extra' && paperColumns <= 32
                ? 'large'
                : 'TOTAL'.length + totalText.length + 1 > requestedTotalWidth
                  ? 'large'
                  : totalSize

        text += ESC.boldOn + receiptTextSizeCommand(resolvedTotalSize)
        text += receiptRow(
            'TOTAL',
            totalText,
            receiptTextWidth(resolvedTotalSize, paperColumns)
        )
        text += ESC.normalSize + ESC.boldOff
    }

    if (showPayment && !tableOrder && order.payment_method) {
        text += receiptTextSizeCommand(textSize)
        text += receiptRow(
            receiptPaymentLabel(order.payment_method),
            money(total),
            receiptTextWidth(textSize, paperColumns)
        )
        text += ESC.normalSize
    }

    if (receiptFooter || (showOrderTime && orderDateTime)) {
        text += sectionGap || '\n'
        text += ESC.alignCenter
        text += receiptTextSizeCommand(textSize)

        if (receiptFooter) {
            text += `${receiptFooter}\n`
        }

        if (showOrderTime && orderDateTime) {
            text += `${orderDateTime}\n`
        }

        text += ESC.normalSize + ESC.alignLeft
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
        activePrinterCycle = true
        let job = null
        let attempt = null
        let maxAttempts = LEGACY_MAX_PRINT_ATTEMPTS
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
                // Use five attempts only when the server explicitly supports them.
                maxAttempts = Number(job.max_print_attempts) === MAX_PRINT_ATTEMPTS
                    ? MAX_PRINT_ATTEMPTS
                    : LEGACY_MAX_PRINT_ATTEMPTS
                const previousAttempts = Number(job.attempts || 0)

                if (previousAttempts >= maxAttempts) {
                    await updateJob(supabase, job.id, {
                        status: 'failed',
                        last_error:
                            job.last_error ||
                            `Falha após ${maxAttempts} tentativas de impressão.`,
                    })
                    sendLog(
                        `Pedido ${job.id} excedeu ${maxAttempts} tentativas. Liberando próximo pedido.`
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
                            `Imprimindo pedido: ${job.id} (tentativa ${attempt}/${maxAttempts})${copies === 2 ? ' (2 vias)' : ''}`
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
                    !retryable || currentAttempt >= maxAttempts

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

                    if (!exhausted) {
                        retryDelayMs = PRINT_RETRY_DELAYS_MS[currentAttempt - 1]
                        sendLog(
                            `Falha ao imprimir ${job.id} (tentativa ${currentAttempt}/${maxAttempts}). Próxima tentativa em ${retryDelayMs / 1000} segundo(s).`
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
        } finally {
            activePrinterCycle = false
            installRequiredUpdateIfIdle()
        }

        if (retryDelayMs !== null) {
            // Preserve retry delays even if Realtime signals.
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

// Keep one printer process and focus its existing window on repeated launches.
if (!app.requestSingleInstanceLock()) {
    app.quit()
} else {
    app.on('second-instance', () => {
        showMainWindow()
    })

    app.whenReady().then(async () => {
    if (process.platform === 'win32' && app.isPackaged) {
        try {
            app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })
        } catch (error) {
            sendLog(`Não foi possível ativar a inicialização com o Windows: ${error.message}`)
        }
    }

    try {
        await initializePrinterConnection()
    } catch (error) {
        dialog.showErrorBox('iMenu Impressora', error.message)
        app.quit()
        return
    }

    if (isLegacyBuild() && requiredPrinterUpdate()) {
        await dialog.showMessageBox({
            type: 'warning',
            title: 'Atualização obrigatória',
            message: 'Atualize o iMenu Impressora Legacy para continuar imprimindo.',
            detail: 'Baixe e instale a versão compatível com Windows 7/8.',
            buttons: ['Baixar instalador'],
        })
        const url = remoteUpdatePolicy?.downloadUrl
        if (typeof url === 'string' && url.startsWith('https://www.imenuapp.com.br/downloads/')) {
            await shell.openExternal(url).catch(() => {})
        }
        app.quit()
        return
    }

    await createTray()
    createWindow()
    addVersionToHelpMenu()
    scheduleUpdateChecks()
    })
}

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

ipcMain.handle('printers:bluetooth-settings', async () => {
    if (process.platform !== 'win32') throw new Error('Bluetooth settings require Windows')
    if (isLegacyBuild()) {
        const child = spawn('control.exe', ['bthprops.cpl'], { detached: true, stdio: 'ignore' })
        child.unref()
    } else {
        await shell.openExternal('ms-settings:bluetooth')
    }
    return { ok: true }
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

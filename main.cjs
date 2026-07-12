const WebSocket = require('ws')
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const os = require('os')
const { exec } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const { SerialPort } = require('serialport')

const baseDir = app.getPath('userData')
const configPath = path.join(baseDir, 'config.json')

const SUPABASE_URL = 'https://mjogdsnxbwhbqcoijrwt.supabase.co'
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qb2dkc254YndoYnFjb2lqcnd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2NjY4MzUsImV4cCI6MjA3NzI0MjgzNX0.S1XLgP7U9ugTXKh4YTrEvzDaroVMN0LhxWc8B3DnkII"
const SUPABASE_SERVICE_ROLE_KEY= "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qb2dkc254YndoYnFjb2lqcnd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTY2NjgzNSwiZXhwIjoyMDc3MjQyODM1fQ.VlAozKcfxZvFi-DnQTsWkWvYbEkzFVyGt7S6yy6c5I0"

let win = null
let printerLoopRunning = false
let stopPrinterLoop = false

const ESC = {
    init: '\x1B\x40',
    boldOn: '\x1B\x45\x01',
    boldOff: '\x1B\x45\x00',
    cut: '\x1D\x56\x41\x10',
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function sendLog(message) {
    console.log(message)
    if (win) win.webContents.send('log', String(message))
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

        POLL_EVERY_MS: 7000,
        CONNECT_TIMEOUT_MS: 5000,
    }

    if (!fs.existsSync(configPath)) {
        return defaults
    }

    return {
        ...defaults,
        ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
    }
}
function saveConfig(config) {
    fs.mkdirSync(baseDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function getSupabase(useServiceRole = false) {
    const key = useServiceRole
        ? SUPABASE_SERVICE_ROLE_KEY
        : SUPABASE_ANON_KEY

    return createClient(SUPABASE_URL, key, {
        realtime: {
            transport: WebSocket,
        },
    })
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

function listWindowsPrinters() {
    return new Promise(resolve => {
        const cmd = `powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"`

        exec(cmd, (err, stdout) => {
            if (err) {
                resolve([])
                return
            }

            const printers = stdout
                .split(/\r?\n/)
                .map(x => x.trim())
                .filter(Boolean)
                .map(name => ({
                    name,
                    type: 'windows-printer',
                }))

            resolve(printers)
        })
    })
}

async function detectPrinters() {
    const comPorts = await listComPorts()
    const windowsPrinters = await listWindowsPrinters()

    return {
        comPorts,
        windowsPrinters,
    }
}

function printRaw(text, config) {
    const mode = String(config.PRINTER_MODE || 'ethernet').toLowerCase()

    if (mode === 'usb') {
        return printUsb(text, config)
    }

    if (mode === 'bluetooth') {
        return printBluetooth(text, config)
    }

    return printEthernet(text, config)
}

function getPrintCopies(config) {
    return config.PRINT_TWO_COPIES === true ? 2 : 1
}

async function printConfiguredCopies(text, config) {
    const copies = getPrintCopies(config)

    for (let copy = 1; copy <= copies; copy += 1) {
        await printRaw(text, config)

        if (copy < copies) {
            await sleep(300)
        }
    }
}

function printUsb(text, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_NAME) {
            reject(new Error('Missing PRINTER_NAME'))
            return
        }

        const safeText = text
            .replaceAll(ESC.init, '')
            .replaceAll(ESC.boldOn, '')
            .replaceAll(ESC.boldOff, '')
            .replaceAll(ESC.cut, '')

        const filePath = path.join(os.tmpdir(), `imenu_print_${Date.now()}.txt`)
        fs.writeFileSync(filePath, safeText, 'utf8')

        const safePrinterName = config.PRINTER_NAME.replaceAll("'", "''")
        const safeFilePath = filePath.replaceAll("'", "''")

        const cmd = `powershell -NoProfile -Command "Get-Content -Raw '${safeFilePath}' | Out-Printer -Name '${safePrinterName}'"`

        exec(cmd, err => {
            try {
                fs.unlinkSync(filePath)
            } catch {}

            if (err) reject(err)
            else resolve()
        })
    })
}

function printEthernet(text, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_IP) {
            reject(new Error('Missing PRINTER_IP'))
            return
        }

        if (!config.PRINTER_PORT) {
            reject(new Error('Missing PRINTER_PORT'))
            return
        }

        const socket = new net.Socket()

        socket.setTimeout(Number(config.CONNECT_TIMEOUT_MS || 5000))

        socket.on('error', err => {
            socket.destroy()
            reject(err)
        })

        socket.on('timeout', () => {
            socket.destroy()
            reject(new Error('Printer timeout'))
        })

        socket.connect(Number(config.PRINTER_PORT), config.PRINTER_IP, () => {
            socket.write(Buffer.from(text, 'binary'), err => {
                if (err) {
                    socket.destroy()
                    reject(err)
                    return
                }

                socket.end()
                resolve()
            })
        })
    })
}

function printBluetooth(text, config) {
    return new Promise((resolve, reject) => {
        if (!config.PRINTER_COM_PORT) {
            reject(new Error('Missing PRINTER_COM_PORT'))
            return
        }

        const port = new SerialPort({
            path: config.PRINTER_COM_PORT,
            baudRate: Number(config.PRINTER_BAUD_RATE || 9600),
            autoOpen: false,
        })

        port.open(err => {
            if (err) {
                reject(err)
                return
            }

            port.write(Buffer.from(text, 'binary'), err => {
                if (err) {
                    port.close(() => {})
                    reject(err)
                    return
                }

                port.drain(err => {
                    port.close(() => {})

                    if (err) reject(err)
                    else resolve()
                })
            })
        })
    })
}

async function getNextJob(supabase, config) {
    const { data, error } = await supabase
        .from('print_jobs')
        .select('*')
        .eq('restaurant_id', config.RESTAURANT_ID)
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1)

    if (error) throw error
    return data?.[0] || null
}

async function updateJob(supabase, id, patch) {
    const { error } = await supabase
        .from('print_jobs')
        .update(patch)
        .eq('id', id)

    if (error) throw error
}

async function buildReceipt(supabase, orderId) {
    const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select(`
      id,
      display_id,
      created_at,
      customer_name,
      payment_method,
      customer_address,
      customer_phone,
      is_delivery
    `)
        .eq('id', orderId)
        .single()

    if (orderErr) throw orderErr

    const { data: items, error: itemsErr } = await supabase
        .from('order_items')
        .select('id, name, quantity, observation')
        .eq('order_id', orderId)

    if (itemsErr) throw itemsErr

    const itemIds = items?.map(i => i.id) || []
    let subs = []

    if (itemIds.length > 0) {
        const { data: subsData, error: subsErr } = await supabase
            .from('order_item_subitems')
            .select('order_item_id, name, quantity')
            .in('order_item_id', itemIds)

        if (subsErr) throw subsErr

        subs = subsData || []
    }

    const subMap = {}

    subs.forEach(s => {
        if (!subMap[s.order_item_id]) {
            subMap[s.order_item_id] = []
        }

        subMap[s.order_item_id].push(s)
    })

    let txt = ESC.init

    txt += ESC.boldOn + 'COZINHA\n' + ESC.boldOff

    txt += `Pedido: ${order.display_id}\n`
    txt += `Hora: ${new Date(order.created_at).toLocaleString('pt-BR')}\n`

    if (order.customer_name) {
        txt += `Cliente: ${order.customer_name}\n`
    }

    if (order.customer_phone) {
        txt += `Telefone: ${order.customer_phone}\n`
    }

    if (order.payment_method) {
        const paymentMap = {
            dinheiro: 'Dinheiro',
            'pix-entrega': 'Pix Entrega',
            'trazer-maquininha': 'Trazer Maquininha',
            pix: 'Pix (Pago Online)',
            cartao: 'Cartão (Pago Online)',
        }

        txt += `Pagamento: ${paymentMap[order.payment_method] ?? order.payment_method}\n`
    }

    txt += `Tipo: ${order.is_delivery ? 'Entrega' : 'Retirada'}\n`

    if (order.customer_address) {
        txt += 'Endereço:\n'
        txt += `${order.customer_address}\n`
    }

    txt += '------------------------------\n'

    for (const item of items || []) {
        txt += `${item.quantity}x ${item.name}\n`

        if (item.observation) {
            txt += `  * ${item.observation}\n`
        }

        const subitems = subMap[item.id] || []

        for (const s of subitems) {
            txt += `  - ${s.quantity}x ${s.name}\n`
        }
    }

    txt += '------------------------------\n\n\n'
    txt += ESC.cut

    return txt
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

    printerLoopRunning = true
    stopPrinterLoop = false

    const supabase = getSupabase(true)

    sendLog('Impressora ativa.')
    sendLog(`Modo: ${config.PRINTER_MODE}`)
    sendLog(`Restaurante: ${config.RESTAURANT_NAME || config.RESTAURANT_ID}`)

    while (!stopPrinterLoop) {
        try {
            const latestConfig = readConfig()

            if (!latestConfig.RESTAURANT_ID) {
                await sleep(2000)
                continue
            }

            const job = await getNextJob(supabase, latestConfig)

            if (job) {
                const copies = getPrintCopies(latestConfig)
                sendLog(`Imprimindo pedido: ${job.id}${copies === 2 ? ' (2 vias)' : ''}`)

                await updateJob(supabase, job.id, {
                    status: 'printing',
                    last_error: null,
                })

                const receipt = await buildReceipt(supabase, job.order_id)

                await printConfiguredCopies(receipt, latestConfig)

                await updateJob(supabase, job.id, {
                    status: 'printed',
                    printed_at: new Date().toISOString(),
                    last_error: null,
                })

                sendLog(`Impresso: ${job.id}${copies === 2 ? ' (2 vias)' : ''}`)
            }
        } catch (err) {
            sendLog(`Erro: ${err.message}`)
        }

        const latestConfig = readConfig()
        await sleep(Number(latestConfig.POLL_EVERY_MS || 7000))
    }

    printerLoopRunning = false
}

function stopLoop() {
    stopPrinterLoop = true
}

async function testPrint(config) {
    const txt =
        ESC.init +
        ESC.boldOn +
        'TESTE IMENU\n' +
        ESC.boldOff +
        `Modo: ${config.PRINTER_MODE}\n` +
        `Hora: ${new Date().toLocaleString('pt-BR')}\n\n\n` +
        ESC.cut

    await printConfiguredCopies(txt, config)
}

async function loginAndGetRestaurant(email, password) {
    const supabase = getSupabase(false)

    const { data: loginData, error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
    })

    if (loginError) throw loginError

    const userId = loginData.user.id

    const { data: restaurant, error: restaurantError } = await supabase
        .from('restaurants')
        .select('id, name')
        .eq('user_id', userId)
        .limit(1)
        .single()

    if (restaurantError) throw restaurantError

    const currentConfig = readConfig()

    const newConfig = {
        ...currentConfig,
        RESTAURANT_ID: restaurant.id,
        RESTAURANT_NAME: restaurant.name || '',
        LOGGED_IN_EMAIL: loginData.user.email || email,
    }

    saveConfig(newConfig)

    return {
        user: {
            id: userId,
            email: loginData.user.email,
        },
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name || '',
    }
}

function createWindow() {
    win = new BrowserWindow({
        width: 780,
        height: 680,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
        },
    })

    win.loadFile('index.html')

    win.webContents.once('did-finish-load', () => {
        const config = readConfig()

        if (config.RESTAURANT_ID) {
            startPrinterLoop().catch(err => {
                printerLoopRunning = false
                sendLog(`Fatal: ${err.message}`)
            })
        }
    })
}

app.whenReady().then(createWindow)

ipcMain.handle('config:get', () => {
    return readConfig()
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

ipcMain.handle('auth:login', async (_, { email, password }) => {
    const result = await loginAndGetRestaurant(email, password)

    startPrinterLoop().catch(err => {
        printerLoopRunning = false
        sendLog(`Fatal: ${err.message}`)
    })

    return result
})

ipcMain.handle('auth:logout', async () => {
    const currentConfig = readConfig()

    saveConfig({
        ...currentConfig,
        RESTAURANT_ID: '',
        RESTAURANT_NAME: '',
        LOGGED_IN_EMAIL: '',
    })

    return { ok: true }
})

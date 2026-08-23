const WebSocket = require('ws')
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const os = require('os')
const { exec } = require('child_process')
const { createClient } = require('@supabase/supabase-js')
const { SerialPort } = require('serialport')
const iconv = require('iconv-lite')

const baseDir = app.getPath('userData')
const configPath = path.join(baseDir, 'config.json')

const SUPABASE_URL = 'https://mjogdsnxbwhbqcoijrwt.supabase.co'
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qb2dkc254YndoYnFjb2lqcnd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE2NjY4MzUsImV4cCI6MjA3NzI0MjgzNX0.S1XLgP7U9ugTXKh4YTrEvzDaroVMN0LhxWc8B3DnkII"
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1qb2dkc254YndoYnFjb2lqcnd0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTY2NjgzNSwiZXhwIjoyMDc3MjQyODM1fQ.VlAozKcfxZvFi-DnQTsWkWvYbEkzFVyGt7S6yy6c5I0"

let win = null
let printerLoopRunning = false
let stopPrinterLoop = false

const RECEIPT_WIDTH = 40

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
                .map(value => value.trim())
                .filter(Boolean)
                .map(name => ({
                    name,
                    type: 'windows-printer',
                }))

            resolve(printers)
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
    const detectedComPorts = await listComPorts()
    const detectedWindowsPrinters = await listWindowsPrinters()

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

function printRaw(text, config) {
    const cleanText = normalizePrinterText(text)
    const mode = String(config.PRINTER_MODE || 'ethernet').toLowerCase()

    if (mode === 'usb') {
        return printUsb(cleanText, config)
    }

    if (mode === 'bluetooth') {
        return printBluetooth(cleanText, config)
    }

    return printEthernet(cleanText, config)
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

        const bytes = iconv.encode(text, 'cp850')
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

        exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psPath}"`, err => {
            try {
                fs.unlinkSync(filePath)
            } catch {}

            try {
                fs.unlinkSync(psPath)
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
            socket.write(iconv.encode(text, 'cp850'), err => {
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

            port.write(iconv.encode(text, 'cp850'), err => {
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

async function getRecentPrintHistory(limit = 15) {
    const config = readConfig()

    if (!config.RESTAURANT_ID) {
        return []
    }

    const supabase = getSupabase(true)
    const { data: jobs, error: jobsError } = await supabase
        .from('print_jobs')
        .select('id, order_id, status, created_at, printed_at')
        .eq('restaurant_id', config.RESTAURANT_ID)
        .eq('status', 'printed')
        .order('printed_at', { ascending: false })
        .limit(Math.max(limit * 2, limit))

    if (jobsError) throw jobsError

    const latestByOrder = []
    const seenOrderIds = new Set()

    for (const job of jobs || []) {
        if (!job.order_id || seenOrderIds.has(job.order_id)) continue

        seenOrderIds.add(job.order_id)
        latestByOrder.push(job)

        if (latestByOrder.length >= limit) break
    }

    const orderIds = latestByOrder.map(job => job.order_id)
    if (orderIds.length === 0) return []

    const { data: orders, error: ordersError } = await supabase
        .from('orders')
        .select('id, display_id, customer_name')
        .in('id', orderIds)

    if (ordersError) throw ordersError

    const orderById = new Map((orders || []).map(order => [order.id, order]))

    return latestByOrder.map(job => {
        const order = orderById.get(job.order_id)

        return {
            order_id: job.order_id,
            display_id: order?.display_id ?? null,
            customer_name: order?.customer_name || '',
            printed_at: job.printed_at || job.created_at || null,
        }
    })
}

async function reprintOrder(orderId) {
    const config = readConfig()

    if (!config.RESTAURANT_ID) {
        throw new Error('Faça login antes de reimprimir um pedido.')
    }

    if (!orderId) {
        throw new Error('Pedido inválido.')
    }

    const supabase = getSupabase(true)

    const { data: matchingJobs, error: matchingJobError } = await supabase
        .from('print_jobs')
        .select('id')
        .eq('restaurant_id', config.RESTAURANT_ID)
        .eq('order_id', orderId)
        .eq('status', 'printed')
        .limit(1)

    if (matchingJobError) throw matchingJobError

    if (!matchingJobs?.length) {
        throw new Error('Pedido não encontrado no histórico deste restaurante.')
    }

    const { data: activeJobs, error: activeJobsError } = await supabase
        .from('print_jobs')
        .select('id')
        .eq('restaurant_id', config.RESTAURANT_ID)
        .in('status', ['queued', 'printing'])
        .limit(1)

    if (activeJobsError) throw activeJobsError

    if (activeJobs?.length) {
        throw new Error('Aguarde os pedidos pendentes terminarem de imprimir.')
    }

    const { data: order, error: orderError } = await supabase
        .from('orders')
        .select('display_id')
        .eq('id', orderId)
        .single()

    if (orderError) throw orderError

    const displayId = order?.display_id || String(orderId).slice(0, 8)
    const copies = getPrintCopies(config)

    sendLog(`Reimprimindo pedido #${displayId}${copies === 2 ? ' (2 vias)' : ''}`)

    const receipt = await buildReceipt(supabase, orderId)
    await printConfiguredCopies(receipt, config)

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

async function buildReceipt(supabase, orderId) {
    const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select(`
          id,
          display_id,
          created_at,
          scheduled_for,
          customer_name,
          customer_phone,
          customer_address,
          payment_method,
          is_delivery,
          subtotal_cents,
          delivery_cents,
          coupon_discount_cents,
          total_cents
        `)
        .eq('id', orderId)
        .single()

    if (orderErr) throw orderErr

    const { data: items, error: itemsErr } = await supabase
        .from('order_items')
        .select(`
          id,
          name,
          quantity,
          observation,
          price_cents,
          total_cents
        `)
        .eq('order_id', orderId)

    if (itemsErr) throw itemsErr

    const itemIds = items?.map(item => item.id) || []
    let subitems = []

    if (itemIds.length > 0) {
        const { data: subitemsData, error: subitemsErr } = await supabase
            .from('order_item_subitems')
            .select(`
              order_item_id,
              name,
              quantity,
              price_cents
            `)
            .in('order_item_id', itemIds)

        if (subitemsErr) throw subitemsErr
        subitems = subitemsData || []
    }

    const subitemsByOrderItem = {}

    for (const subitem of subitems) {
        if (!subitemsByOrderItem[subitem.order_item_id]) {
            subitemsByOrderItem[subitem.order_item_id] = []
        }

        subitemsByOrderItem[subitem.order_item_id].push(subitem)
    }

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
    text += ESC.boldOn + ESC.doubleSize + 'COZINHA\n'
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

    text += `Hora: ${new Date(order.created_at).toLocaleString('pt-BR')}\n`
    text += `Tipo: ${pickup ? 'Retirada' : 'Entrega'}\n`

    if (order.customer_name) {
        text += `Cliente: ${order.customer_name}\n`
    }

    if (order.customer_phone) {
        text += `Telefone: ${order.customer_phone}\n`
    }

    if (!pickup && order.customer_address) {
        text += 'Endereco:\n'
        text += `${order.customer_address}\n`
    }

    if (order.payment_method) {
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
        text += receiptRow(`${quantity}x ${item.name}`, money(itemTotal))
        text += ESC.boldOff

        const selectedSubitems = subitemsByOrderItem[item.id] || []

        for (const selected of selectedSubitems) {
            const selectedQuantity = Math.max(1, Number(selected.quantity) || 1)
            const selectedPrice = numericCents(selected.price_cents)
            const selectedLabel = `  - ${selectedQuantity}x ${selected.name}`

            text += selectedPrice > 0
                ? receiptRow(
                    selectedLabel,
                    `+${money(selectedPrice * selectedQuantity)}`
                )
                : `${selectedLabel}\n`
        }

        if (item.observation) {
            text += `  OBS: ${item.observation}\n`
        }
    }

    text += `${separator}\n`

    const subtotal = numericCents(order.subtotal_cents)
    const delivery = pickup ? 0 : numericCents(order.delivery_cents)
    const storedDiscount = numericCents(order.coupon_discount_cents)
    const discount = storedDiscount > 0
        ? storedDiscount
        : Math.max(subtotal + delivery - numericCents(order.total_cents), 0)
    const total = numericCents(
        order.total_cents,
        subtotal + delivery - discount
    )

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

    text += '\n\n\n'
    text += ESC.cut

    return text
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

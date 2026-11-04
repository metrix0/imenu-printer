const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
const rendererSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

function updateFixture(t) {
    const fixture = main(t)
    const installer = path.join(fixture.dir, 'installer.exe')
    fs.writeFileSync(installer, 'test installer')
    fixture.context.installerPath = installer
    fixture.run("app.isPackaged = true; pendingUpdate = { version: '1.4.6', installerPath };")
    return fixture
}

test('update requests NSIS restart and waits for successful installer spawn before stopping', async t => {
    const { context, run } = updateFixture(t)
    const child = new EventEmitter()
    let stopped = false
    let detached = false
    child.unref = () => { detached = true }
    context.stopLoop = () => { stopped = true }
    context.mockSpawn = (_file, args, options) => {
        assert.deepEqual(Array.from(args), ['--updated', '/S', '--force-run'])
        assert.equal(options.detached, true)
        return child
    }
    const update = context.installPendingUpdate()
    assert.equal(stopped, false)
    assert.equal(run('forceQuit'), false)
    // Do not actually schedule an app quit in this isolated process test.
    context.setTimeout = () => {}
    child.emit('spawn')
    assert.equal((await update).ok, true)
    assert.equal(stopped, true)
    assert.equal(detached, true)
    assert.equal(run('forceQuit'), true)
})

test('failed installer spawn keeps the app running and permits another attempt', async t => {
    const { context, run } = updateFixture(t)
    context.mockSpawn = () => {
        const child = new EventEmitter()
        queueMicrotask(() => child.emit('error', new Error('ENOENT')))
        return child
    }
    context.stopLoop = () => assert.fail('printing must continue after a failed spawn')
    const result = await context.installPendingUpdate()
    assert.equal(result.ok, false)
    assert.equal(run('forceQuit'), false)
    assert.equal(run('updateInstallScheduled'), false)
})

test('updater waits for printing and prevents duplicate installer launches', async t => {
    const { context, run } = updateFixture(t)
    context.mockSpawn = () => assert.fail('installer must not launch')
    run('activePrintOperations = 1')
    assert.equal((await context.installPendingUpdate()).ok, false)
    run('activePrintOperations = 0; updateInstallScheduled = true')
    assert.equal((await context.installPendingUpdate()).ok, false)
})

test('installer never terminates its own process tree during an update', () => {
    const installer = fs.readFileSync(path.join(__dirname, 'build/installer.nsh'), 'utf8')
    assert.doesNotMatch(installer, /ExecToStack[^\n]*taskkill[^\n]*\s\/T\b/i)
})

function main(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imenu-printer-test-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const handlers = {}
    const electron = {
        app: { getPath: () => dir, getVersion: () => '1.4.4', getName: () => 'iMenu Impressora',
            requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    }
    const context = vm.createContext({
        Buffer, URL, process, console: { log() {} }, setTimeout, clearTimeout, setInterval,
        clearInterval, __dirname,
        require: name => {
            if (name === 'electron') return electron
            if (name === 'ws') return class {}
            if (name === 'serialport') return { SerialPort: overrides.SerialPort || { list: async () => [] } }
            if (name === '@supabase/supabase-js') return { createClient() {} }
            if (name === 'iconv-lite') return { encode: value => Buffer.from(value) }
            if (name === 'child_process') return { ...require(name),
                exec: (...args) => context.mockExec(...args),
                execFile: (...args) => context.mockExecFile(...args),
                spawn: (...args) => context.mockSpawn(...args) }
            if (name === 'fs' && overrides.fs) return overrides.fs
            return require(name)
        },
    })
    vm.runInContext(mainSource, context, { filename: 'main.cjs' })
    Object.assign(context, overrides)
    return { context, handlers, dir, run: code => vm.runInContext(code, context) }
}

function select(values = []) {
    let selected = ''
    const el = { type: 'select-one', options: values.map(value => ({ value })),
        appendChild(option) { this.options.push(option) } }
    Object.defineProperty(el, 'value', {
        get: () => selected,
        set: value => { selected = el.options.some(option => option.value === String(value)) ? String(value) : '' },
    })
    return el
}

function renderer(functions, extras = {}) {
    const elements = {
        PRINTER_MODE: select(['usb', 'bluetooth', 'ethernet']),
        PRINTER_NAME: select(), PRINTER_COM_PORT: select(),
        PRINTER_IP: { value: '' }, PRINTER_PORT: { value: '' },
        PRINT_TWO_COPIES: { type: 'checkbox', checked: false },
    }
    const context = vm.createContext({
        document: { getElementById: id => elements[id], createElement: () => ({}) },
        updateModeVisibility() {}, updatePrinterStatus() {},
        ...extras,
    })
    vm.runInContext("let currentConfig = {}; let printerSelectionRevision = 0; const fields = ['PRINTER_MODE', 'PRINTER_NAME', 'PRINTER_COM_PORT', 'PRINTER_IP', 'PRINTER_PORT', 'PRINT_TWO_COPIES'];", context)
    for (const name of functions) {
        const start = rendererSource.indexOf('    function ' + name + '(')
        const rest = rendererSource.slice(start)
        const end = rest.slice(1).search(/\n    (?:async )?function /)
        vm.runInContext(end < 0 ? rest : rest.slice(0, end + 1), context)
    }
    return { context, elements }
}

test('saved USB and COM selections survive hydration before discovery and an unrelated save', () => {
    const { context, elements } = renderer(['setPrinterOption', 'setFormConfig', 'getFormConfig'])
    context.setFormConfig({ PRINTER_MODE: 'usb', PRINTER_NAME: 'Cozinha á', PRINTER_COM_PORT: 'COM7',
        PRINTER_BAUD_RATE: 115200, CONNECT_TIMEOUT_MS: 9000 })
    elements.PRINT_TWO_COPIES.checked = true
    const saved = context.getFormConfig()
    assert.equal(saved.PRINTER_NAME, 'Cozinha á')
    assert.equal(saved.PRINTER_COM_PORT, 'COM7')
    assert.equal(saved.PRINTER_BAUD_RATE, 115200)
    assert.equal(saved.CONNECT_TIMEOUT_MS, 9000)
})

test('native Windows discovery still finds a new printer when PowerShell is blocked', async t => {
    const { context, run } = main(t)
    context.nativePrinters = [{ name: 'Cozinha Çafé', displayName: 'Friendly name' }]
    run('win = { webContents: { getPrintersAsync: async () => nativePrinters } }')
    context.mockExec = (_cmd, _options, cb) => cb(new Error('blocked'), '')
    context.mockExecFile = (_file, _args, _options, cb) => cb(new Error('blocked'), '')
    const printers = await context.listWindowsPrinters()
    assert.equal(printers[0]?.name, 'Cozinha Çafé')
})

test('discovery suggests receipt printers without automatically selecting document printers', t => {
    const { context } = main(t)
    const devices = context.buildDiscoveredPrinters([{ name: 'EPSON L3250 Series' }, { name: 'POS-80' }], [], [])
    assert.equal(devices.find(item => item.name === 'EPSON L3250 Series').autoSelect, false)
    assert.equal(devices.find(item => item.name === 'POS-80').autoSelect, true)
    assert.equal(devices.length, 2, 'document printers remain available for explicit selection')
})

test('Bluetooth pairing alone and generic serial devices cannot be automatically selected', t => {
    const { context } = main(t)
    const devices = context.buildDiscoveredPrinters([], [{ path: 'COM7', friendlyName: 'Standard Serial over Bluetooth link' }], ['My phone'])
    assert.equal(devices.some(item => item.autoSelect), false)
})

test('a Windows queue and its COM port appear as one selectable printer', t => {
    const { context } = main(t)
    const devices = context.buildDiscoveredPrinters([{ name: 'POS-80', portName: 'COM7:' }],
        [{ path: 'COM7', friendlyName: 'POS-80' }], ['POS-80'])
    assert.equal(devices.length, 1)
    assert.equal(devices[0].mode, 'usb')
    assert.equal(devices[0].printerName, 'POS-80')
})

test('paired Bluetooth printers with no print route stay visible but cannot print', t => {
    const { context } = main(t)
    const devices = context.buildDiscoveredPrinters([], [], ['RP Printer'])
    assert.equal(devices.length, 1)
    assert.equal(devices[0].ready, false)
    assert.equal(devices[0].mode, null)
})

test('new USB and Bluetooth devices appear on refresh without overwriting saved selections', async t => {
    const { context } = main(t)
    context.saveConfig({ PRINTER_MODE: 'usb', PRINTER_NAME: 'Saved printer' })
    context.listWindowsPrinters = async () => [{ name: 'New POS-80', portName: 'USB001' }]
    context.listComPorts = async () => [{ path: 'COM8', friendlyName: 'RP Printer' }]
    context.listPairedBluetoothDevices = async () => ['RP Printer']
    const result = await context.detectPrinters()
    assert.equal(result.devices.some(item => item.printerName === 'New POS-80'), true)
    assert.equal(result.devices.some(item => item.comPort === 'COM8'), true)
    assert.equal(result.windowsPrinters[0].name, 'Saved printer')
    assert.equal(context.readConfig().PRINTER_NAME, 'Saved printer')
})

test('Bluetooth writes and drains the exact receipt, then closes the port', async t => {
    let opened, closed = false
    let written
    class Serial extends EventEmitter {
        constructor(options) { super(); opened = options }
        open(cb) { this.isOpen = true; cb() }
        write(bytes, cb) { written = bytes; cb() }
        drain(cb) { cb() }
        close(cb) { this.isOpen = false; closed = true; cb() }
    }
    const { context } = main(t, { SerialPort: Serial })
    const bytes = Buffer.from([27, 64, 65, 10])
    await context.printBluetooth(bytes, { PRINTER_COM_PORT: 'COM8', PRINTER_BAUD_RATE: 115200 })
    assert.equal(opened.path, 'COM8')
    assert.equal(opened.baudRate, 115200)
    assert.deepEqual(written, bytes)
    assert.equal(closed, true)
})

for (const stage of ['open', 'write', 'drain']) {
    test(`Bluetooth ${stage} failure is retryable only before any data was sent`, async t => {
        let closed = false
        class Serial extends EventEmitter {
            open(cb) { this.isOpen = stage !== 'open'; cb(stage === 'open' ? new Error('busy') : null) }
            write(_bytes, cb) { cb(stage === 'write' ? new Error('write failed') : null) }
            drain(cb) { cb(new Error('drain failed')) }
            close(cb) { this.isOpen = false; closed = true; cb() }
        }
        const { context } = main(t, { SerialPort: Serial })
        await assert.rejects(context.printBluetooth(Buffer.from('receipt'), { PRINTER_COM_PORT: 'COM8' }),
            error => error.printRetryable === (stage === 'open'))
        assert.equal(closed, stage !== 'open')
    })
}

test('network printing sends exact bytes over a real loopback TCP connection', async t => {
    const net = require('node:net')
    const chunks = []
    let finished
    const received = new Promise(resolve => { finished = resolve })
    const server = net.createServer(socket => {
        socket.on('data', bytes => chunks.push(bytes))
        socket.on('end', finished)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const { context } = main(t)
    const bytes = Buffer.from([27, 64, 84, 69, 83, 84, 10])
    await context.printEthernet(bytes, { PRINTER_IP: '127.0.0.1', PRINTER_PORT: server.address().port })
    await received
    assert.deepEqual(Buffer.concat(chunks), bytes)
})

test('an unreachable network printer fails safely before sending bytes', async t => {
    const net = require('node:net')
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    const { context } = main(t)
    await assert.rejects(context.printEthernet(Buffer.from('receipt'), { PRINTER_IP: '127.0.0.1', PRINTER_PORT: port }),
        error => error.code === 'ECONNREFUSED' && error.printRetryable === true)
})

test('native discovery errors fall through to legacy discovery without losing saved routes', async t => {
    const { context, run } = main(t)
    run('win = { webContents: { getPrintersAsync: async () => { throw new Error("unavailable") } } }')
    context.listWindowsPrintersPrimary = async () => []
    context.runPrinterDiscoveryCommand = async () => [Buffer.from('POS-80').toString('base64') + '|' + Buffer.from('USB001').toString('base64')]
    const printers = await context.listWindowsPrinters()
    assert.equal(printers[0].name, 'POS-80')
    assert.equal(printers[0].portName, 'USB001')
})

test('PowerShell queue discovery accepts both single-object and multi-object JSON', async t => {
    const { context } = main(t)
    for (const output of [{ Name: 'Cozinha Çafé', PortName: 'USB001' }, [{ Name: 'POS-80', PortName: 'COM7:' }, { Name: 'Other', PortName: 'IP_192.168.1.20' }]]) {
        context.mockExec = (_cmd, _options, cb) => cb(null, JSON.stringify(output))
        const printers = await context.listWindowsPrintersPrimary()
        assert.deepEqual(Array.from(printers, item => item.name), [].concat(output).map(item => item.Name))
    }
})

test('saved virtual queues are retained without being suggested for new setups', async t => {
    const { context } = main(t)
    context.saveConfig({ PRINTER_MODE: 'usb', PRINTER_NAME: 'AnyDesk Printer' })
    context.listWindowsPrinters = async () => [{ name: 'AnyDesk Printer' }]
    context.listComPorts = async () => []
    context.listPairedBluetoothDevices = async () => []
    const result = await context.detectPrinters()
    assert.equal(result.devices.length, 0)
    assert.equal(result.windowsPrinters[0].name, 'AnyDesk Printer')
    assert.equal(context.readConfig().PRINTER_NAME, 'AnyDesk Printer')
})

test('Windows RAW helper rejects a nonexistent queue before sending anything', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const { context } = main(t)
    context.mockExec = require('node:child_process').exec
    await assert.rejects(context.printUsb(Buffer.from('IMENU TEST\n'), {
        PRINTER_NAME: 'iMenu-nonexistent-QA-' + process.pid + '-' + Date.now(),
    }), error => error.printRetryable === true && /IMENU_PRINT_NOT_SENT/.test(error.message))
})

test('virtual printer suggestions exclude AnyDesk and OneNote variants', t => {
    const { context } = main(t)
    const devices = context.buildDiscoveredPrinters([
        { name: 'AnyDesk Printer' }, { name: 'OneNote for Windows 10' },
        { name: 'OneNote (Desktop)' }, { name: 'POS-80' },
    ], [], [])
    assert.deepEqual(Array.from(devices, item => item.name), ['POS-80'])
})

test('a missing printer configuration leaves queued orders untouched', async t => {
    let nextCalls = 0
    const { context, run } = main(t)
    context.readConfig = () => ({ RESTAURANT_ID: 'r1', PRINTER_MODE: 'usb', PRINTER_NAME: '' })
    const channel = { on() { return this }, subscribe() { return this } }
    context.getSupabase = () => ({ auth: { getSession: async () => ({ data: { session: {} } }) },
        channel: () => channel, removeChannel: async () => {} })
    context.recoverInterruptedJobs = async () => {}
    context.getNextJob = async () => { nextCalls++; run('stopPrinterLoop = true'); return null }
    context.waitForPrinterWake = async () => run('stopPrinterLoop = true')
    context.sleep = async () => run('stopPrinterLoop = true')
    await context.startPrinterLoop()
    assert.equal(nextCalls, 0)
})

test('missing configuration gives an actionable error before manual reprint API calls', async t => {
    let calls = 0
    const { context } = main(t)
    context.readConfig = () => ({ RESTAURANT_ID: 'r1', PRINTER_MODE: 'usb', PRINTER_NAME: '' })
    context.printerApi = async () => { calls++; return {} }
    await assert.rejects(context.reprintOrder('order1'), /selecione.*impressora/i)
    assert.equal(calls, 0)
})

test('USB errors with uncertain output are never retried automatically', async t => {
    const { context } = main(t)
    context.mockExec = (_command, _options, callback) => callback(new Error('Spooler connection lost'))
    await assert.rejects(context.printUsb(Buffer.from('receipt'), { PRINTER_NAME: 'POS-80' }),
        error => error.printRetryable === false)
})

test('confirmed USB pre-send failures remain retryable', async t => {
    const { context } = main(t)
    context.mockExec = (_command, _options, callback) => callback(new Error('IMENU_PRINT_NOT_SENT: OpenPrinter failed'))
    await assert.rejects(context.printUsb(Buffer.from('receipt'), { PRINTER_NAME: 'POS-80' }),
        error => error.printRetryable === true)
})

test('printer configuration persists without changing receipt preferences or login', async t => {
    const { context, handlers } = main(t)
    context.saveConfig({ RESTAURANT_ID: 'r1', PRINTER_MODE: 'usb', PRINTER_NAME: 'POS-80',
        RECEIPT_PAPER_WIDTH: '80', RECEIPT_TITLE: 'Minha cozinha', PRINT_TWO_COPIES: true })
    context.startPrinterLoop = async () => {}
    await handlers['config:save'](null, { PRINTER_NAME: 'Outra impressora' })
    const config = context.readConfig()
    assert.equal(config.RESTAURANT_ID, 'r1')
    assert.equal(config.RECEIPT_PAPER_WIDTH, '80')
    assert.equal(config.RECEIPT_TITLE, 'Minha cozinha')
    assert.equal(config.PRINT_TWO_COPIES, true)
    assert.equal(config.PRINTER_NAME, 'Outra impressora')
})

test('interrupted configuration replacement keeps the previous valid file', t => {
    let failRename = false
    const { context } = main(t, { fs: { ...fs, renameSync: (...args) => {
        if (failRename) throw new Error('Replacement blocked')
        return fs.renameSync(...args)
    } } })
    context.saveConfig({ PRINTER_MODE: 'usb', PRINTER_NAME: 'POS-80' })
    failRename = true
    assert.throws(() => context.saveConfig({ PRINTER_NAME: 'Other' }), /Replacement blocked/)
    assert.equal(context.readConfig().PRINTER_NAME, 'POS-80')
})

test('a disconnected saved USB route resumes unchanged when the device returns', async t => {
    let nextCalls = 0
    let scans = 0
    let pauses = 0
    const config = { RESTAURANT_ID: 'r1', PRINTER_MODE: 'usb', PRINTER_NAME: 'Minha POS-80' }
    const { context, run } = main(t)
    context.readConfig = () => config
    context.listWindowsPrinters = async () => ++scans === 1
        ? [{ name: 'Other printer' }] : [{ name: config.PRINTER_NAME }]
    const channel = { on() { return this }, subscribe() { return this } }
    context.getSupabase = () => ({ auth: { getSession: async () => ({ data: { session: {} } }) },
        channel: () => channel, removeChannel: async () => {} })
    context.recoverInterruptedJobs = async () => {}
    context.waitForPrinterWake = async () => { if (++pauses > 1) run('stopPrinterLoop = true') }
    context.getNextJob = async () => { nextCalls++; run('stopPrinterLoop = true'); return null }
    await context.startPrinterLoop()
    assert.equal(scans, 2)
    assert.equal(nextCalls, 1)
    assert.equal(config.PRINTER_NAME, 'Minha POS-80')
})

test('saved routes remain usable when Windows enumeration is unavailable', async t => {
    const { context } = main(t)
    context.listWindowsPrinters = async () => []
    await context.checkPrinterAvailability({ PRINTER_MODE: 'usb', PRINTER_NAME: 'Existing printer' })
})

test('missing Bluetooth port is detected without substituting a different port', async t => {
    const { context } = main(t)
    context.listComPorts = async () => [{ path: 'COM9' }]
    await assert.rejects(context.checkPrinterAvailability({ PRINTER_MODE: 'bluetooth', PRINTER_COM_PORT: 'COM7' }),
        error => error.printerUnavailable === true)
})

test('a second-copy failure never retries a receipt that may already have printed', async t => {
    const { context } = main(t)
    let copies = 0
    context.sleep = async () => {}
    context.printRaw = async () => { if (++copies === 2) throw context.createOperationError('Connection lost', true) }
    await assert.rejects(context.printConfiguredCopies(['receipt 1', 'receipt 2'], { PRINT_TWO_COPIES: true }),
        error => error.printRetryable === false)
    assert.equal(copies, 2)
})

test('availability checks reuse a recent scan and rescan a changed route', async t => {
    const { context } = main(t)
    let scans = 0
    context.listWindowsPrinters = async () => { scans++; return [{ name: 'POS-80' }, { name: 'Other' }] }
    await context.checkPrinterAvailability({ PRINTER_MODE: 'usb', PRINTER_NAME: 'POS-80' })
    await context.checkPrinterAvailability({ PRINTER_MODE: 'usb', PRINTER_NAME: 'POS-80' })
    assert.equal(scans, 1)
    await context.checkPrinterAvailability({ PRINTER_MODE: 'usb', PRINTER_NAME: 'Other' })
    assert.equal(scans, 2)
})



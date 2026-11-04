const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const mainSource = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8')
const rendererSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')

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
            if (name === 'serialport') return { SerialPort: { list: async () => [] } }
            if (name === '@supabase/supabase-js') return { createClient() {} }
            if (name === 'iconv-lite') return { encode: value => Buffer.from(value) }
            if (name === 'child_process') return { ...require(name), exec: (...args) => context.mockExec(...args) }
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

(() => {
    const SAVE_DELAY_MS = 350
    const VIA_SUFFIXES = [
        'TITLE',
        'FOOTER_TEXT',
        'SHOW_ORDER_TIME',
        'SHOW_CUSTOMER_NAME',
        'SHOW_CUSTOMER_PHONE',
        'SHOW_ADDRESS',
        'SHOW_PAYMENT',
        'SHOW_ITEM_PRICES',
        'SHOW_SUBITEMS',
        'SHOW_OBSERVATIONS',
        'SHOW_TOTALS',
        'TEXT_SIZE',
        'ORDER_SIZE',
        'ITEM_SIZE',
        'TOTAL_SIZE',
        'SPACING',
        'SHOW_LOGO',
        'LOGO_PATH',
        'LOGO_POSITION',
        'LOGO_SIZE',
    ]
    const DEFAULTS = {
        TITLE: 'COZINHA',
        FOOTER_TEXT: '',
        SHOW_ORDER_TIME: true,
        SHOW_CUSTOMER_NAME: true,
        SHOW_CUSTOMER_PHONE: true,
        SHOW_ADDRESS: true,
        SHOW_PAYMENT: true,
        SHOW_ITEM_PRICES: true,
        SHOW_SUBITEMS: true,
        SHOW_OBSERVATIONS: true,
        SHOW_TOTALS: true,
        TEXT_SIZE: 'large',
        ORDER_SIZE: 'extra',
        ITEM_SIZE: 'large',
        TOTAL_SIZE: 'extra',
        SPACING: 'normal',
        SHOW_LOGO: false,
        LOGO_PATH: '',
        LOGO_POSITION: 'top',
        LOGO_SIZE: 'large',
    }

    let saveTimer = null
    let activeVia = 1
    let via2Customized = false
    const logoPreviewByVia = { 1: null, 2: null }

    function configKey(via, suffix) {
        return via === 2 ? `RECEIPT_2_${suffix}` : `RECEIPT_${suffix}`
    }

    function fieldId(via, suffix) {
        return `RECEIPT_V${via}_${suffix}`
    }

    function checked(id) {
        return document.getElementById(id)?.checked === true
    }

    function value(id) {
        return document.getElementById(id)?.value || ''
    }

    function normalizedChoice(id, allowed, fallback) {
        const candidate = value(id).trim().toLowerCase()
        return allowed.includes(candidate) ? candidate : fallback
    }

    function localFileName(filePath) {
        return String(filePath || '').split(/[\\/]/).pop() || ''
    }

    function updateLogoControls(via) {
        const enabled = checked(fieldId(via, 'SHOW_LOGO'))
        const controls = document.getElementById(fieldId(via, 'LOGO_CONTROLS'))
        const fileName = document.getElementById(fieldId(via, 'LOGO_FILE_NAME'))
        const filePath = value(fieldId(via, 'LOGO_PATH')).trim()

        controls?.classList.toggle('hidden', !enabled)
        if (fileName) {
            fileName.textContent = filePath
                ? localFileName(filePath)
                : 'Nenhuma imagem selecionada'
        }
    }

    async function loadLogoPreview(via) {
        const filePath = value(fieldId(via, 'LOGO_PATH')).trim()
        if (!filePath) {
            logoPreviewByVia[via] = null
            renderPreview()
            return
        }

        try {
            const result = await window.api.getReceiptLogoPreview(filePath)
            logoPreviewByVia[via] = result?.exists ? result.previewDataUrl : null
        } catch {
            logoPreviewByVia[via] = null
        }

        renderPreview()
    }

    async function selectLogo(via) {
        const result = await window.api.selectReceiptLogo()
        if (!result || result.canceled) return

        const pathField = document.getElementById(fieldId(via, 'LOGO_PATH'))
        if (pathField) pathField.value = result.path || ''
        logoPreviewByVia[via] = result.previewDataUrl || null

        if (via === 2) via2Customized = true
        updateLogoControls(via)
        scheduleSave()
    }

    function getViaSettings(via) {
        const title = value(fieldId(via, 'TITLE')).trim().slice(0, 24)

        return {
            TITLE: via === 2 ? title : (title || 'COZINHA'),
            FOOTER_TEXT: value(fieldId(via, 'FOOTER_TEXT')).trim().slice(0, 120),
            SHOW_ORDER_TIME: checked(fieldId(via, 'SHOW_ORDER_TIME')),
            SHOW_CUSTOMER_NAME: checked(fieldId(via, 'SHOW_CUSTOMER_NAME')),
            SHOW_CUSTOMER_PHONE: checked(fieldId(via, 'SHOW_CUSTOMER_PHONE')),
            SHOW_ADDRESS: checked(fieldId(via, 'SHOW_ADDRESS')),
            SHOW_PAYMENT: checked(fieldId(via, 'SHOW_PAYMENT')),
            SHOW_ITEM_PRICES: checked(fieldId(via, 'SHOW_ITEM_PRICES')),
            SHOW_SUBITEMS: checked(fieldId(via, 'SHOW_SUBITEMS')),
            SHOW_OBSERVATIONS: checked(fieldId(via, 'SHOW_OBSERVATIONS')),
            SHOW_TOTALS: checked(fieldId(via, 'SHOW_TOTALS')),
            TEXT_SIZE: normalizedChoice(
                fieldId(via, 'TEXT_SIZE'),
                ['normal', 'large'],
                'large'
            ),
            ORDER_SIZE: normalizedChoice(
                fieldId(via, 'ORDER_SIZE'),
                ['normal', 'large', 'extra'],
                'extra'
            ),
            ITEM_SIZE: normalizedChoice(
                fieldId(via, 'ITEM_SIZE'),
                ['normal', 'large'],
                'large'
            ),
            TOTAL_SIZE: normalizedChoice(
                fieldId(via, 'TOTAL_SIZE'),
                ['normal', 'large', 'extra'],
                'extra'
            ),
            SPACING: normalizedChoice(
                fieldId(via, 'SPACING'),
                ['compact', 'normal', 'spacious'],
                'normal'
            ),
            SHOW_LOGO: checked(fieldId(via, 'SHOW_LOGO')),
            LOGO_PATH: value(fieldId(via, 'LOGO_PATH')).trim(),
            LOGO_POSITION: value(fieldId(via, 'LOGO_POSITION')) === 'bottom' ? 'bottom' : 'top',
            LOGO_SIZE: normalizedChoice(
                fieldId(via, 'LOGO_SIZE'),
                ['small', 'medium', 'large'],
                'large'
            ),
        }
    }

    function getSettings() {
        const settings = {}
        const via1Settings = getViaSettings(1)

        for (const suffix of VIA_SUFFIXES) {
            settings[configKey(1, suffix)] = via1Settings[suffix]
        }

        if (via2Customized) {
            const via2Settings = getViaSettings(2)
            for (const suffix of VIA_SUFFIXES) {
                settings[configKey(2, suffix)] = via2Settings[suffix]
            }
        }

        return settings
    }

    function receiptRow(left, right, width = 40) {
        const room = Math.max(1, width - left.length - right.length)
        if (left.length + right.length + 1 > width) {
            return `${left}\n${right.padStart(width)}`
        }
        return `${left}${' '.repeat(room)}${right}`
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;')
    }

    function previewSizeClass(size) {
        if (size === 'extra') return 'receiptPreviewSizeExtra'
        if (size === 'large') return 'receiptPreviewSizeLarge'
        return ''
    }

    function previewGapClass(spacing) {
        if (spacing === 'spacious') return 'receiptPreviewGapSpacious'
        if (spacing === 'normal') return 'receiptPreviewGapNormal'
        return ''
    }

    function previewRowWidth(size) {
        return size === 'extra' ? 20 : 40
    }

    function renderPreview() {
        const preview = document.getElementById('receiptPreviewText')
        const label = document.getElementById('receiptPreviewLabel')
        const logoTop = document.getElementById('receiptPreviewLogoTop')
        const logoBottom = document.getElementById('receiptPreviewLogoBottom')
        if (!preview) return

        const settings = getViaSettings(activeVia)
        const logoPreview = logoPreviewByVia[activeVia]
        const showLogo = settings.SHOW_LOGO && Boolean(settings.LOGO_PATH) && Boolean(logoPreview)
        const logoAtBottom = settings.LOGO_POSITION === 'bottom'
        const logoWidths = { small: '42%', medium: '62%', large: '80%' }
        const logoMaxHeights = { small: '70px', medium: '95px', large: '120px' }

        if (label) label.textContent = `Prévia aproximada — Via ${activeVia}`

        for (const [element, visible] of [
            [logoTop, showLogo && !logoAtBottom],
            [logoBottom, showLogo && logoAtBottom],
        ]) {
            if (!element) continue
            element.src = visible ? logoPreview : ''
            element.classList.toggle('hidden', !visible)
            element.style.maxWidth = logoWidths[settings.LOGO_SIZE] || logoWidths.large
            element.style.maxHeight = logoMaxHeights[settings.LOGO_SIZE] || logoMaxHeights.large
        }

        const chunks = []
        const line = (text, classes = '') => {
            chunks.push(
                `<span class="receiptPreviewLine ${classes}">${escapeHtml(text)}</span>`
            )
        }
        const gap = () => {
            const className = previewGapClass(settings.SPACING)
            if (className) chunks.push(`<span class="${className}"></span>`)
        }
        const textClass = previewSizeClass(settings.TEXT_SIZE)
        const itemClass = previewSizeClass(settings.ITEM_SIZE)
        const orderClass = previewSizeClass(settings.ORDER_SIZE)
        const totalClass = previewSizeClass(settings.TOTAL_SIZE)
        const separatorLine = () => {
            chunks.push('<span class="receiptPreviewSeparator" aria-hidden="true"></span>')
        }

        if (settings.TITLE) {
            line(settings.TITLE.toUpperCase(), 'receiptPreviewBold receiptPreviewCenter')
            separatorLine()
            gap()
        }
        line('PEDIDO #42', `receiptPreviewBold ${orderClass}`)
        if (settings.SHOW_ORDER_TIME) line('Hora: 26/09/2026 12:30:00', textClass)
        if (settings.SHOW_CUSTOMER_NAME) line('Cliente: Maria', textClass)
        if (settings.SHOW_CUSTOMER_PHONE) line('Telefone: (11) 99999-9999', textClass)
        if (settings.SHOW_ADDRESS) {
            line('Endereco:', textClass)
            line('Rua Exemplo, 123 - Centro', textClass)
        }
        if (settings.SHOW_PAYMENT) line('Pagamento: Pix (pago online)', textClass)
        separatorLine()
        gap()
        line(
            settings.SHOW_ITEM_PRICES
                ? receiptRow(
                    '2x X-Burger',
                    'R$ 38,00',
                    previewRowWidth(settings.ITEM_SIZE)
                )
                : '2x X-Burger',
            `receiptPreviewBold ${itemClass}`
        )
        if (settings.SHOW_SUBITEMS) {
            line(
                settings.SHOW_ITEM_PRICES
                    ? receiptRow('  - 1x Bacon', '+R$ 3,00')
                    : '  - 1x Bacon',
                textClass
            )
        }
        if (settings.SHOW_OBSERVATIONS) {
            line('  OBS: Sem cebola', `receiptPreviewBold ${textClass}`)
        }
        separatorLine()
        gap()
        if (settings.SHOW_TOTALS) {
            line(receiptRow('Subtotal', 'R$ 41,00'), textClass)
            line(receiptRow('Entrega', 'R$ 5,00'), textClass)
            separatorLine()
            gap()
            line(
                receiptRow(
                    'TOTAL',
                    'R$ 46,00',
                    previewRowWidth(settings.TOTAL_SIZE)
                ),
                `receiptPreviewBold ${totalClass}`
            )
        }
        if (settings.FOOTER_TEXT) {
            gap()
            line(settings.FOOTER_TEXT, `receiptPreviewCenter ${textClass}`)
        }

        preview.innerHTML = chunks.join('')
    }

    async function saveSettings() {
        clearTimeout(saveTimer)
        saveTimer = null
        await window.api.saveConfig(getSettings())
    }

    function scheduleSave() {
        renderPreview()
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
            saveSettings().catch(() => {})
        }, SAVE_DELAY_MS)
    }

    function toggle(via, suffix, title) {
        const id = fieldId(via, suffix)
        return `
            <label class="checkboxOption" for="${id}">
                <input id="${id}" type="checkbox" />
                <span class="checkboxOptionText">
                    <span class="checkboxOptionTitle">${title}</span>
                </span>
            </label>
        `
    }

    function selectField(via, suffix, label, options) {
        const id = fieldId(via, suffix)
        const optionMarkup = options
            .map(option => `<option value="${option.value}">${option.label}</option>`)
            .join('')

        return `
            <div class="field" style="margin-top:0">
                <label for="${id}">${label}</label>
                <select id="${id}">${optionMarkup}</select>
            </div>
        `
    }

    function logoControls(via) {
        return `
            <div id="${fieldId(via, 'LOGO_CONTROLS')}" class="receiptLogoControls hidden">
                <input id="${fieldId(via, 'LOGO_PATH')}" type="hidden" />
                <div class="receiptFieldsGrid">
                    <div class="field" style="margin-top:0">
                        <label>Arquivo local</label>
                        <div class="receiptLogoFileRow">
                            <button class="ghost" id="${fieldId(via, 'LOGO_SELECT')}" type="button">Selecionar imagem</button>
                            <span id="${fieldId(via, 'LOGO_FILE_NAME')}" class="receiptLogoFileName">Nenhuma imagem selecionada</span>
                        </div>
                        <p class="localOnly">PNG ou JPG. O arquivo fica somente neste computador.</p>
                    </div>
                    <div class="field" style="margin-top:0">
                        <label for="${fieldId(via, 'LOGO_POSITION')}">Posição do logo</label>
                        <select id="${fieldId(via, 'LOGO_POSITION')}">
                            <option value="top">No topo</option>
                            <option value="bottom">No final</option>
                        </select>
                    </div>
                    ${selectField(via, 'LOGO_SIZE', 'Tamanho do logo', [
                        { value: 'small', label: 'Pequeno' },
                        { value: 'medium', label: 'Médio' },
                        { value: 'large', label: 'Grande' },
                    ])}
                </div>
            </div>
        `
    }

    function viaPanel(via) {
        return `
            <div id="receiptViaPanel${via}" class="${via === 1 ? '' : 'hidden'}">
                <div class="receiptFieldsGrid">
                    <div class="field" style="margin-top:0">
                        <label for="${fieldId(via, 'TITLE')}">Título da Via ${via}</label>
                        <input id="${fieldId(via, 'TITLE')}" maxlength="24" placeholder="Ex.: Cozinha" />
                    </div>
                    <div class="field" style="margin-top:0">
                        <label for="${fieldId(via, 'FOOTER_TEXT')}">Texto no final</label>
                        <input id="${fieldId(via, 'FOOTER_TEXT')}" maxlength="120" placeholder="Ex.: Obrigado!" />
                    </div>
                </div>

                <div class="receiptFieldsGrid receiptAppearanceFields">
                    ${selectField(via, 'TEXT_SIZE', 'Tamanho do texto', [
                        { value: 'normal', label: 'Normal' },
                        { value: 'large', label: 'Grande' },
                    ])}
                    ${selectField(via, 'ORDER_SIZE', 'Número do pedido', [
                        { value: 'normal', label: 'Normal' },
                        { value: 'large', label: 'Grande' },
                        { value: 'extra', label: 'Extra grande' },
                    ])}
                    ${selectField(via, 'ITEM_SIZE', 'Itens', [
                        { value: 'normal', label: 'Normal' },
                        { value: 'large', label: 'Grande' },
                    ])}
                    ${selectField(via, 'TOTAL_SIZE', 'Total', [
                        { value: 'normal', label: 'Normal' },
                        { value: 'large', label: 'Grande' },
                        { value: 'extra', label: 'Extra grande' },
                    ])}
                    ${selectField(via, 'SPACING', 'Espaçamento', [
                        { value: 'compact', label: 'Compacto' },
                        { value: 'normal', label: 'Normal' },
                        { value: 'spacious', label: 'Espaçoso' },
                    ])}
                </div>

                <div class="receiptToggles">
                    ${toggle(via, 'SHOW_ORDER_TIME', 'Horário do pedido')}
                    ${toggle(via, 'SHOW_CUSTOMER_NAME', 'Nome do cliente')}
                    ${toggle(via, 'SHOW_CUSTOMER_PHONE', 'Telefone')}
                    ${toggle(via, 'SHOW_ADDRESS', 'Endereço')}
                    ${toggle(via, 'SHOW_PAYMENT', 'Pagamento')}
                    ${toggle(via, 'SHOW_ITEM_PRICES', 'Preços')}
                    ${toggle(via, 'SHOW_SUBITEMS', 'Complementos')}
                    ${toggle(via, 'SHOW_OBSERVATIONS', 'Observações')}
                    ${toggle(via, 'SHOW_TOTALS', 'Totais')}
                    ${toggle(via, 'SHOW_LOGO', 'Logo na comanda')}
                </div>

                ${logoControls(via)}
            </div>
        `
    }

    function resolvedConfigValue(config, via, suffix) {
        const key = configKey(via, suffix)

        if (via === 2 && Object.prototype.hasOwnProperty.call(config, key)) {
            return config[key]
        }

        if (via === 2 && suffix === 'TITLE') {
            return 'ENTREGA'
        }

        const primaryKey = configKey(1, suffix)
        if (Object.prototype.hasOwnProperty.call(config, primaryKey)) {
            return config[primaryKey]
        }

        if (suffix === 'TITLE' && config.RECEIPT_NAME_1) {
            return config.RECEIPT_NAME_1
        }

        return DEFAULTS[suffix]
    }

    function setViaFields(config, via) {
        const resolvedTitle = resolvedConfigValue(config, via, 'TITLE')
        document.getElementById(fieldId(via, 'TITLE')).value =
            via === 2
                ? String(resolvedTitle ?? '')
                : String(resolvedTitle || 'COZINHA')
        document.getElementById(fieldId(via, 'FOOTER_TEXT')).value =
            String(resolvedConfigValue(config, via, 'FOOTER_TEXT') || '')
        document.getElementById(fieldId(via, 'LOGO_PATH')).value =
            String(resolvedConfigValue(config, via, 'LOGO_PATH') || '')
        document.getElementById(fieldId(via, 'LOGO_POSITION')).value =
            resolvedConfigValue(config, via, 'LOGO_POSITION') === 'bottom' ? 'bottom' : 'top'
        document.getElementById(fieldId(via, 'TEXT_SIZE')).value =
            String(resolvedConfigValue(config, via, 'TEXT_SIZE') || 'large')
        document.getElementById(fieldId(via, 'ORDER_SIZE')).value =
            String(resolvedConfigValue(config, via, 'ORDER_SIZE') || 'extra')
        document.getElementById(fieldId(via, 'ITEM_SIZE')).value =
            String(resolvedConfigValue(config, via, 'ITEM_SIZE') || 'large')
        document.getElementById(fieldId(via, 'TOTAL_SIZE')).value =
            String(resolvedConfigValue(config, via, 'TOTAL_SIZE') || 'extra')
        document.getElementById(fieldId(via, 'SPACING')).value =
            String(resolvedConfigValue(config, via, 'SPACING') || 'normal')
        document.getElementById(fieldId(via, 'LOGO_SIZE')).value =
            String(resolvedConfigValue(config, via, 'LOGO_SIZE') || 'large')

        for (const suffix of VIA_SUFFIXES) {
            if (typeof DEFAULTS[suffix] !== 'boolean') continue
            const element = document.getElementById(fieldId(via, suffix))
            if (element) element.checked = resolvedConfigValue(config, via, suffix) !== false
        }
    }

    function copyVia1ToVia2() {
        const via1 = getViaSettings(1)

        for (const suffix of VIA_SUFFIXES) {
            const element = document.getElementById(fieldId(2, suffix))
            if (!element) continue

            if (typeof DEFAULTS[suffix] === 'boolean') {
                element.checked = via1[suffix] === true
            } else if (suffix === 'TITLE') {
                element.value = 'ENTREGA'
            } else {
                element.value = via1[suffix]
            }
        }

        logoPreviewByVia[2] = logoPreviewByVia[1]
        updateLogoControls(2)
        via2Customized = true
        scheduleSave()
    }

    function selectVia(via) {
        activeVia = via

        for (const candidate of [1, 2]) {
            document.getElementById(`receiptViaPanel${candidate}`)?.classList.toggle(
                'hidden',
                candidate !== via
            )
            document.getElementById(`receiptViaTab${candidate}`)?.classList.toggle(
                'active',
                candidate === via
            )
        }

        renderPreview()
    }

    function setTwoCopies(enabled) {
        const tabs = document.getElementById('receiptViaTabs')
        if (tabs) tabs.classList.toggle('hidden', !enabled)

        if (enabled && !via2Customized) {
            copyVia1ToVia2()
        }

        if (!enabled && activeVia === 2) {
            selectVia(1)
        }
    }

    async function resetSettings() {
        const resetConfig = {}

        for (const via of [1, 2]) {
            for (const suffix of VIA_SUFFIXES) {
                resetConfig[configKey(via, suffix)] =
                    via === 2 && suffix === 'TITLE' ? 'ENTREGA' : DEFAULTS[suffix]
            }
        }

        setViaFields(resetConfig, 1)
        setViaFields(resetConfig, 2)
        logoPreviewByVia[1] = null
        logoPreviewByVia[2] = null
        updateLogoControls(1)
        updateLogoControls(2)
        via2Customized = true
        renderPreview()
        await window.api.saveConfig(resetConfig)
    }

    async function mount() {
        const mount = document.getElementById('receiptSettingsMount')
        if (!mount || mount.dataset.mounted === 'true') return
        mount.dataset.mounted = 'true'

        mount.innerHTML = `
            <div class="receiptSettingsGrid">
                <div>
                    <div id="receiptViaTabs" class="receiptViaTabs hidden">
                        <button id="receiptViaTab1" class="receiptViaTab active" type="button">Via 1</button>
                        <button id="receiptViaTab2" class="receiptViaTab" type="button">Via 2</button>
                    </div>

                    ${viaPanel(1)}
                    ${viaPanel(2)}

                    <div class="buttonRow">
                        <button class="ghost" id="receiptResetButton" type="button">Restaurar padrão</button>
                    </div>
                </div>

                <div class="receiptPreviewWrap">
                    <p id="receiptPreviewLabel" class="receiptPreviewLabel">Prévia aproximada — Via 1</p>
                    <div id="receiptPreview" class="receiptPreview">
                        <img id="receiptPreviewLogoTop" class="receiptPreviewLogo receiptPreviewLogoTop hidden" alt="" />
                        <pre id="receiptPreviewText" class="receiptPreviewText"></pre>
                        <img id="receiptPreviewLogoBottom" class="receiptPreviewLogo receiptPreviewLogoBottom hidden" alt="" />
                    </div>
                </div>
            </div>
        `

        const config = await window.api.getConfig()
        via2Customized = VIA_SUFFIXES.some(suffix =>
            Object.prototype.hasOwnProperty.call(config, configKey(2, suffix))
        )

        setViaFields(config, 1)
        setViaFields(config, 2)
        updateLogoControls(1)
        updateLogoControls(2)
        await Promise.all([loadLogoPreview(1), loadLogoPreview(2)])

        for (const via of [1, 2]) {
            document.getElementById(fieldId(via, 'TITLE'))?.addEventListener('input', () => {
                if (via === 2) via2Customized = true
                scheduleSave()
            })
            document.getElementById(fieldId(via, 'FOOTER_TEXT'))?.addEventListener('input', () => {
                if (via === 2) via2Customized = true
                scheduleSave()
            })

            for (const suffix of VIA_SUFFIXES) {
                if (typeof DEFAULTS[suffix] !== 'boolean') continue
                document.getElementById(fieldId(via, suffix))?.addEventListener('change', () => {
                    if (via === 2) via2Customized = true
                    if (suffix === 'SHOW_LOGO') updateLogoControls(via)
                    scheduleSave()
                })
            }

            for (const suffix of [
                'TEXT_SIZE',
                'ORDER_SIZE',
                'ITEM_SIZE',
                'TOTAL_SIZE',
                'SPACING',
                'LOGO_POSITION',
                'LOGO_SIZE',
            ]) {
                document.getElementById(fieldId(via, suffix))?.addEventListener('change', () => {
                    if (via === 2) via2Customized = true
                    scheduleSave()
                })
            }

            document.getElementById(fieldId(via, 'LOGO_SELECT'))?.addEventListener('click', () => {
                selectLogo(via).catch(() => {})
            })
        }

        document.getElementById('receiptViaTab1').addEventListener('click', () => selectVia(1))
        document.getElementById('receiptViaTab2').addEventListener('click', () => selectVia(2))
        document.getElementById('receiptResetButton').addEventListener('click', () => {
            resetSettings().catch(() => {})
        })

        const copiesEnabled = config.PRINT_TWO_COPIES === true
        setTwoCopies(copiesEnabled)
        selectVia(1)

        window.addEventListener('imenu:copies-changed', event => {
            setTwoCopies(event.detail?.enabled === true)
        })
    }

    mount().catch(() => {})
})()

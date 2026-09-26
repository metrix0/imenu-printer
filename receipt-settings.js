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
    }

    let saveTimer = null
    let activeVia = 1
    let via2Customized = false

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

    function getViaSettings(via) {
        return {
            TITLE: value(fieldId(via, 'TITLE')).trim().slice(0, 24) || (via === 2 ? 'ENTREGA' : 'COZINHA'),
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

    function renderPreview() {
        const preview = document.getElementById('receiptPreview')
        const label = document.getElementById('receiptPreviewLabel')
        if (!preview) return

        const settings = getViaSettings(activeVia)
        const lines = []

        if (label) label.textContent = `Prévia aproximada — Via ${activeVia}`

        lines.push(settings.TITLE.toUpperCase())
        lines.push('----------------------------------------')
        lines.push('PEDIDO #42')
        if (settings.SHOW_ORDER_TIME) lines.push('Hora: 26/09/2026 12:30:00')
        lines.push('Tipo: Entrega')
        if (settings.SHOW_CUSTOMER_NAME) lines.push('Cliente: Maria')
        if (settings.SHOW_CUSTOMER_PHONE) lines.push('Telefone: (11) 99999-9999')
        if (settings.SHOW_ADDRESS) {
            lines.push('Endereco:')
            lines.push('Rua Exemplo, 123 - Centro')
        }
        if (settings.SHOW_PAYMENT) lines.push('Pagamento: Pix (pago online)')
        lines.push('----------------------------------------')
        lines.push(
            settings.SHOW_ITEM_PRICES
                ? receiptRow('2x X-Burger', 'R$ 38,00')
                : '2x X-Burger'
        )
        if (settings.SHOW_SUBITEMS) {
            lines.push(
                settings.SHOW_ITEM_PRICES
                    ? receiptRow('  - 1x Bacon', '+R$ 3,00')
                    : '  - 1x Bacon'
            )
        }
        if (settings.SHOW_OBSERVATIONS) lines.push('  OBS: Sem cebola')
        lines.push('----------------------------------------')
        if (settings.SHOW_TOTALS) {
            lines.push(receiptRow('Subtotal', 'R$ 41,00'))
            lines.push(receiptRow('Entrega', 'R$ 5,00'))
            lines.push(receiptRow('TOTAL', 'R$ 46,00'))
        }
        if (settings.FOOTER_TEXT) {
            lines.push('')
            lines.push(settings.FOOTER_TEXT)
        }

        preview.textContent = lines.join('\n')
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
                </div>
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
        document.getElementById(fieldId(via, 'TITLE')).value =
            String(resolvedConfigValue(config, via, 'TITLE') || (via === 2 ? 'ENTREGA' : 'COZINHA'))
        document.getElementById(fieldId(via, 'FOOTER_TEXT')).value =
            String(resolvedConfigValue(config, via, 'FOOTER_TEXT') || '')

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
                    <pre id="receiptPreview" class="receiptPreview"></pre>
                </div>
            </div>
        `

        const config = await window.api.getConfig()
        via2Customized = VIA_SUFFIXES.some(suffix =>
            Object.prototype.hasOwnProperty.call(config, configKey(2, suffix))
        )

        setViaFields(config, 1)
        setViaFields(config, 2)

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
                    scheduleSave()
                })
            }
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

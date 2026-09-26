(() => {
    const SAVE_DELAY_MS = 350
    const DEFAULTS = {
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
    }
    let saveTimer = null

    function checked(id) {
        return document.getElementById(id)?.checked === true
    }

    function value(id) {
        return document.getElementById(id)?.value || ''
    }

    function getSettings() {
        return {
            RECEIPT_TITLE: value('RECEIPT_TITLE').trim().slice(0, 24) || 'COZINHA',
            RECEIPT_FOOTER_TEXT: value('RECEIPT_FOOTER_TEXT').trim().slice(0, 120),
            RECEIPT_SHOW_ORDER_TIME: checked('RECEIPT_SHOW_ORDER_TIME'),
            RECEIPT_SHOW_CUSTOMER_NAME: checked('RECEIPT_SHOW_CUSTOMER_NAME'),
            RECEIPT_SHOW_CUSTOMER_PHONE: checked('RECEIPT_SHOW_CUSTOMER_PHONE'),
            RECEIPT_SHOW_ADDRESS: checked('RECEIPT_SHOW_ADDRESS'),
            RECEIPT_SHOW_PAYMENT: checked('RECEIPT_SHOW_PAYMENT'),
            RECEIPT_SHOW_ITEM_PRICES: checked('RECEIPT_SHOW_ITEM_PRICES'),
            RECEIPT_SHOW_SUBITEMS: checked('RECEIPT_SHOW_SUBITEMS'),
            RECEIPT_SHOW_OBSERVATIONS: checked('RECEIPT_SHOW_OBSERVATIONS'),
            RECEIPT_SHOW_TOTALS: checked('RECEIPT_SHOW_TOTALS'),
        }
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
        if (!preview) return

        const settings = getSettings()
        const lines = []
        lines.push(settings.RECEIPT_TITLE.toUpperCase())
        lines.push('----------------------------------------')
        lines.push('PEDIDO #42')
        if (settings.RECEIPT_SHOW_ORDER_TIME) lines.push('Hora: 26/09/2026 12:30:00')
        lines.push('Tipo: Entrega')
        if (settings.RECEIPT_SHOW_CUSTOMER_NAME) lines.push('Cliente: Maria')
        if (settings.RECEIPT_SHOW_CUSTOMER_PHONE) lines.push('Telefone: (11) 99999-9999')
        if (settings.RECEIPT_SHOW_ADDRESS) {
            lines.push('Endereco:')
            lines.push('Rua Exemplo, 123 - Centro')
        }
        if (settings.RECEIPT_SHOW_PAYMENT) lines.push('Pagamento: Pix (pago online)')
        lines.push('----------------------------------------')
        lines.push(
            settings.RECEIPT_SHOW_ITEM_PRICES
                ? receiptRow('2x X-Burger', 'R$ 38,00')
                : '2x X-Burger'
        )
        if (settings.RECEIPT_SHOW_SUBITEMS) {
            lines.push(
                settings.RECEIPT_SHOW_ITEM_PRICES
                    ? receiptRow('  - 1x Bacon', '+R$ 3,00')
                    : '  - 1x Bacon'
            )
        }
        if (settings.RECEIPT_SHOW_OBSERVATIONS) lines.push('  OBS: Sem cebola')
        lines.push('----------------------------------------')
        if (settings.RECEIPT_SHOW_TOTALS) {
            lines.push(receiptRow('Subtotal', 'R$ 41,00'))
            lines.push(receiptRow('Entrega', 'R$ 5,00'))
            lines.push(receiptRow('TOTAL', 'R$ 46,00'))
        }
        if (settings.RECEIPT_FOOTER_TEXT) {
            lines.push('')
            lines.push(settings.RECEIPT_FOOTER_TEXT)
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

    function toggle(id, title) {
        return `
            <label class="checkboxOption" for="${id}">
                <input id="${id}" type="checkbox" />
                <span class="checkboxOptionText">
                    <span class="checkboxOptionTitle">${title}</span>
                </span>
            </label>
        `
    }

    function setFields(config) {
        const title = document.getElementById('RECEIPT_TITLE')
        const footer = document.getElementById('RECEIPT_FOOTER_TEXT')
        title.value = config.RECEIPT_TITLE || config.RECEIPT_NAME_1 || DEFAULTS.RECEIPT_TITLE
        footer.value = config.RECEIPT_FOOTER_TEXT || ''

        for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
            if (typeof defaultValue !== 'boolean') continue
            const element = document.getElementById(key)
            if (element) element.checked = config[key] !== false
        }
    }

    async function resetSettings() {
        setFields(DEFAULTS)
        renderPreview()
        await window.api.saveConfig(DEFAULTS)
    }

    async function mount() {
        const mount = document.getElementById('receiptSettingsMount')
        if (!mount || mount.dataset.mounted === 'true') return
        mount.dataset.mounted = 'true'

        mount.innerHTML = `
            <div class="receiptSettingsGrid">
                <div>
                    <div class="receiptFieldsGrid">
                        <div class="field" style="margin-top:0">
                            <label for="RECEIPT_TITLE">Título da comanda</label>
                            <input id="RECEIPT_TITLE" maxlength="24" placeholder="Ex.: Cozinha" />
                        </div>
                        <div class="field" style="margin-top:0">
                            <label for="RECEIPT_FOOTER_TEXT">Texto no final</label>
                            <input id="RECEIPT_FOOTER_TEXT" maxlength="120" placeholder="Ex.: Obrigado!" />
                        </div>
                    </div>

                    <div class="receiptToggles">
                        ${toggle('RECEIPT_SHOW_ORDER_TIME', 'Horário do pedido')}
                        ${toggle('RECEIPT_SHOW_CUSTOMER_NAME', 'Nome do cliente')}
                        ${toggle('RECEIPT_SHOW_CUSTOMER_PHONE', 'Telefone')}
                        ${toggle('RECEIPT_SHOW_ADDRESS', 'Endereço')}
                        ${toggle('RECEIPT_SHOW_PAYMENT', 'Pagamento')}
                        ${toggle('RECEIPT_SHOW_ITEM_PRICES', 'Preços')}
                        ${toggle('RECEIPT_SHOW_SUBITEMS', 'Complementos')}
                        ${toggle('RECEIPT_SHOW_OBSERVATIONS', 'Observações')}
                        ${toggle('RECEIPT_SHOW_TOTALS', 'Totais')}
                    </div>

                    <div class="buttonRow">
                        <button class="ghost" id="receiptResetButton" type="button">Restaurar padrão</button>
                    </div>
                    <p class="localOnly">As alterações são salvas automaticamente no arquivo local deste computador. Nada é enviado ao Supabase.</p>
                </div>

                <div class="receiptPreviewWrap">
                    <p class="receiptPreviewLabel">Prévia aproximada da comanda</p>
                    <pre id="receiptPreview" class="receiptPreview"></pre>
                </div>
            </div>
        `

        const config = await window.api.getConfig()
        setFields(config)
        renderPreview()

        document.getElementById('RECEIPT_TITLE').addEventListener('input', scheduleSave)
        document.getElementById('RECEIPT_FOOTER_TEXT').addEventListener('input', scheduleSave)

        for (const key of Object.keys(DEFAULTS)) {
            if (typeof DEFAULTS[key] !== 'boolean') continue
            document.getElementById(key)?.addEventListener('change', scheduleSave)
        }

        document.getElementById('receiptResetButton').addEventListener('click', () => {
            resetSettings().catch(() => {})
        })
    }

    mount().catch(() => {})
})()

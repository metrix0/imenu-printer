(() => {
    const SETTINGS_ID = 'receiptSettings'
    const SAVE_DELAY_MS = 350
    let saveTimer = null

    function createElement(tag, attributes = {}, text = '') {
        const element = document.createElement(tag)

        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'className') {
                element.className = value
            } else if (key === 'htmlFor') {
                element.htmlFor = value
            } else {
                element.setAttribute(key, value)
            }
        }

        if (text) {
            element.textContent = text
        }

        return element
    }

    function createTextField(id, labelText, placeholder) {
        const wrapper = createElement('div', { className: 'field receiptNameField' })
        const label = createElement('label', { htmlFor: id, id: `${id}_LABEL` }, labelText)
        const input = createElement('input', {
            id,
            type: 'text',
            maxlength: '20',
            placeholder,
            autocomplete: 'off',
        })

        wrapper.append(label, input)
        return wrapper
    }

    function createCheckbox(id, title, description) {
        const label = createElement('label', {
            className: 'checkboxOption receiptCheckbox',
            htmlFor: id,
        })
        const input = createElement('input', {
            id,
            type: 'checkbox',
        })
        const text = createElement('span', { className: 'checkboxOptionText' })
        const titleElement = createElement('span', { className: 'checkboxOptionTitle' }, title)
        const descriptionElement = createElement(
            'span',
            { className: 'checkboxOptionDescription' },
            description
        )

        text.append(titleElement, descriptionElement)
        label.append(input, text)
        return label
    }

    function injectStyles() {
        if (document.getElementById('receiptSettingsStyles')) return

        const style = createElement('style', { id: 'receiptSettingsStyles' })
        style.textContent = `
            .receiptSettingsBlock {
                margin-top: 20px;
                padding-top: 20px;
                border-top: 1px solid var(--border, #e5e7eb);
            }

            .receiptSettingsTitle {
                margin: 0;
                font-size: 17px;
                font-weight: 800;
                color: var(--text, #111827);
            }

            .receiptSettingsDescription {
                margin: 5px 0 0;
                font-size: 13px;
                line-height: 1.45;
                color: var(--muted, #6b7280);
            }

            .receiptNamesGrid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 14px;
            }

            .receiptCheckbox {
                margin-top: 12px;
            }

            @media (max-width: 720px) {
                .receiptNamesGrid {
                    grid-template-columns: 1fr;
                }
            }
        `
        document.head.appendChild(style)
    }

    function getSettingsConfig() {
        return {
            RECEIPT_NAME_1: document.getElementById('RECEIPT_NAME_1')?.value || '',
            RECEIPT_NAME_2: document.getElementById('RECEIPT_NAME_2')?.value || '',
            PRINT_READY_TIME: document.getElementById('PRINT_READY_TIME')?.checked === true,
            PRINT_DELIVERY_TIME: document.getElementById('PRINT_DELIVERY_TIME')?.checked === true,
        }
    }

    async function saveSettings() {
        clearTimeout(saveTimer)
        saveTimer = null
        await window.api.saveConfig(getSettingsConfig())
    }

    function scheduleSave() {
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
            saveSettings().catch(() => {})
        }, SAVE_DELAY_MS)
    }

    function updateCopyFields() {
        const twoCopies = document.getElementById('PRINT_TWO_COPIES')?.checked === true
        const secondField = document.getElementById('RECEIPT_NAME_2')?.closest('.receiptNameField')
        const firstLabel = document.getElementById('RECEIPT_NAME_1_LABEL')

        if (secondField) {
            secondField.style.display = twoCopies ? 'block' : 'none'
        }

        if (firstLabel) {
            firstLabel.textContent = twoCopies ? 'Nome da 1ª via' : 'Nome da comanda'
        }
    }

    async function mount() {
        if (document.getElementById(SETTINGS_ID)) return

        const twoCopiesOption = document.getElementById('PRINT_TWO_COPIES')
        const printerCard = twoCopiesOption?.closest('.card')

        if (!twoCopiesOption || !printerCard) return

        injectStyles()

        const section = createElement('div', {
            id: SETTINGS_ID,
            className: 'receiptSettingsBlock',
        })
        const title = createElement('h3', { className: 'receiptSettingsTitle' }, 'Comanda')
        const description = createElement(
            'p',
            { className: 'receiptSettingsDescription' },
            'Defina o nome de cada via e as informações de tempo que serão impressas.'
        )
        const namesGrid = createElement('div', { className: 'receiptNamesGrid' })

        namesGrid.append(
            createTextField('RECEIPT_NAME_1', 'Nome da comanda', 'Ex.: Cozinha'),
            createTextField('RECEIPT_NAME_2', 'Nome da 2ª via', 'Ex.: Entrega')
        )

        section.append(
            title,
            description,
            namesGrid,
            createCheckbox(
                'PRINT_READY_TIME',
                'Imprimir tempo até pronto',
                'Mostra o tempo de preparo configurado no restaurante.'
            ),
            createCheckbox(
                'PRINT_DELIVERY_TIME',
                'Imprimir tempo até entrega',
                'Mostra o prazo estimado de entrega do pedido.'
            )
        )

        twoCopiesOption.closest('.checkboxOption').insertAdjacentElement('afterend', section)

        const config = await window.api.getConfig()
        document.getElementById('RECEIPT_NAME_1').value = config.RECEIPT_NAME_1 || ''
        document.getElementById('RECEIPT_NAME_2').value = config.RECEIPT_NAME_2 || ''
        document.getElementById('PRINT_READY_TIME').checked = config.PRINT_READY_TIME === true
        document.getElementById('PRINT_DELIVERY_TIME').checked = config.PRINT_DELIVERY_TIME === true

        document.getElementById('RECEIPT_NAME_1').addEventListener('input', scheduleSave)
        document.getElementById('RECEIPT_NAME_2').addEventListener('input', scheduleSave)
        document.getElementById('PRINT_READY_TIME').addEventListener('change', saveSettings)
        document.getElementById('PRINT_DELIVERY_TIME').addEventListener('change', saveSettings)

        twoCopiesOption.addEventListener('change', updateCopyFields)
        updateCopyFields()
    }

    mount().catch(() => {})
})()

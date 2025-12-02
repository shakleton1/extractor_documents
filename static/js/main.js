document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const resultsTable = document.getElementById('resultsTable');
    const resultsTableHead = document.getElementById('resultsTableHead');
    const logsContainer = document.getElementById('logs');
    const logsSection = document.querySelector('.logs-section');
    const startProcessingBtn = document.getElementById('startProcessing');
    const clearFilesBtn = document.getElementById('clearFiles');
    const clearLogsBtn = document.getElementById('clearLogs');
    const toggleLogsBtn = document.getElementById('toggleLogs');
    const exportBtn = document.getElementById('exportBtn');

    if (!dropZone || !fileInput || !fileList || !resultsTableHead || !resultsTable) {
        return;
    }

    let processingQueue = [];
    let isProcessing = false;
    let accumulatedResults = [];
    let orderedFields = [];

    initDragAndDrop();
    initControls();
    renderResultsHeader();
    window.addToLog = addToLog;

    function initDragAndDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
        });

        dropZone.addEventListener('drop', event => {
            queueFiles(Array.from(event.dataTransfer?.files || []));
        });

        fileInput.addEventListener('change', event => {
            queueFiles(Array.from(event.target.files || []));
            event.target.value = '';
        });
    }

    function initControls() {
        startProcessingBtn?.addEventListener('click', async () => {
            if (isProcessing) {
                return;
            }

            if (processingQueue.length === 0) {
                addToLog('Очередь пуста. Добавьте PDF-файлы перед стартом обработки.', 'warning');
                return;
            }

            isProcessing = true;
            startProcessingBtn.disabled = true;
            addToLog('Начало обработки файлов...', 'info');
            resetAllFileIndicators();

            while (processingQueue.length > 0 && isProcessing) {
                const file = processingQueue.shift();
                await processFile(file);
            }

            isProcessing = false;
            startProcessingBtn.disabled = false;

            if (processingQueue.length === 0) {
                addToLog('Обработка завершена', 'success');
            }
        });

        clearFilesBtn?.addEventListener('click', () => {
            if (processingQueue.length === 0 && fileList.children.length === 0) {
                addToLog('Список файлов уже пуст', 'info');
                return;
            }

            processingQueue = [];
            fileList.innerHTML = '';
            if (fileInput) {
                fileInput.value = '';
            }
            addToLog('Список файлов очищен', 'info');
        });

        clearLogsBtn?.addEventListener('click', () => {
            if (logsContainer) {
                logsContainer.innerHTML = '';
            }
        });

        toggleLogsBtn?.addEventListener('click', () => {
            if (!logsSection) {
                return;
            }
            const collapsed = logsSection.classList.toggle('collapsed');
            const icon = toggleLogsBtn.querySelector('i');
            if (icon) {
                icon.className = collapsed ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
            }
        });

        exportBtn?.addEventListener('click', () => {
            if (typeof XLSX === 'undefined') {
                addToLog('Ошибка: библиотека для экспорта не загружена', 'error');
                return;
            }

            try {
                if (accumulatedResults.length === 0 || orderedFields.length === 0) {
                    addToLog('Нет данных для экспорта', 'warning');
                    return;
                }

                const headers = [...orderedFields];
                const data = [headers];

                accumulatedResults.forEach(result => {
                    const rowData = headers.map(field => {
                        const value = result?.[field];
                        return value === undefined || value === null || value === '' ? '-' : value;
                    });
                    data.push(rowData);
                });

                const workbook = XLSX.utils.book_new();
                const worksheet = XLSX.utils.aoa_to_sheet(data);
                worksheet['!cols'] = headers.map(() => ({ wch: 20 }));
                XLSX.utils.book_append_sheet(workbook, worksheet, 'Результаты обработки');

                const date = new Date().toISOString().split('T')[0];
                XLSX.writeFile(workbook, `Результаты_обработки_${date}.xlsx`);
                addToLog('Экспорт результатов в Excel выполнен успешно', 'success');
            } catch (error) {
                addToLog(`Ошибка при экспорте: ${error.message}`, 'error');
            }
        });
    }

    function preventDefaults(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    function queueFiles(files) {
        files.forEach(file => {
            if (!isPdfFile(file)) {
                addToLog(`Неподдерживаемый формат файла: ${file?.name || 'неизвестно'}`, 'error');
                return;
            }

            if (isFileQueued(file.name)) {
                addToLog(`Файл "${file.name}" уже в очереди`, 'warning');
                return;
            }

            processingQueue.push(file);
            addToFileList(file);
            addToLog(`Файл добавлен в очередь: ${file.name}`, 'info');
        });
    }

    function isPdfFile(file) {
        if (!file) {
            return false;
        }
        const mimeMatches = file.type === 'application/pdf';
        const extensionMatches = (file.name || '').toLowerCase().endsWith('.pdf');
        return mimeMatches || extensionMatches;
    }

    function isFileQueued(filename) {
        return processingQueue.some(file => file.name === filename);
    }

    function addToFileList(file) {
        const fileItem = document.createElement('div');
        fileItem.className = 'list-group-item';
        fileItem.dataset.filename = file.name;

        const wrapper = document.createElement('div');
        wrapper.className = 'file-item';

        const info = document.createElement('div');
        info.className = 'file-info';

        const icon = document.createElement('i');
        icon.className = 'fas fa-file-pdf me-2';
        icon.setAttribute('aria-hidden', 'true');

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = file.name;

        const spinnerIcon = document.createElement('i');
        spinnerIcon.className = 'fas fa-spinner processing-icon';
        spinnerIcon.style.display = 'none';
        spinnerIcon.setAttribute('aria-hidden', 'true');

        const successIcon = document.createElement('i');
        successIcon.className = 'fas fa-check success-icon';
        successIcon.style.display = 'none';
        successIcon.setAttribute('aria-hidden', 'true');

        info.append(icon, nameSpan, spinnerIcon, successIcon);

        const statusWrapper = document.createElement('div');
        statusWrapper.className = 'file-status';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-sm btn-outline-danger';
        removeBtn.title = 'Удалить файл';
        removeBtn.innerHTML = '<i class="fas fa-times"></i>';
        removeBtn.addEventListener('click', () => removeFile(file.name));

        statusWrapper.appendChild(removeBtn);
        wrapper.append(info, statusWrapper);
        fileItem.appendChild(wrapper);
        fileList.appendChild(fileItem);
    }

    function removeFile(filename) {
        const initialLength = processingQueue.length;
        processingQueue = processingQueue.filter(file => file.name !== filename);

        const fileItem = findFileItem(filename);
        if (fileItem) {
            fileItem.remove();
        }

        const message = initialLength === processingQueue.length
            ? `Файл "${filename}" удалён из списка`
            : `Файл "${filename}" удалён из очереди`;
        addToLog(message, 'info');
    }

    function findFileItem(filename) {
        return Array.from(fileList.querySelectorAll('.list-group-item')).find(item => item.dataset.filename === filename);
    }

    async function processFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        if (typeof getCurrentSettings === 'function') {
            formData.append('settings', JSON.stringify(getCurrentSettings()));
        }

        const fileItem = findFileItem(file.name);
        setFileIndicators(fileItem, 'processing');

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || 'Сервер вернул ошибку');
            }

            if (payload.status === 'success') {
                addToLog(`Файл успешно обработан: ${file.name}`, 'success');
                appendResult(file.name, payload.result || {}, payload.result_order || []);
                setFileIndicators(fileItem, 'success');
            } else if (payload.status === 'already_processed') {
                addToLog(`Файл уже был обработан ранее: ${file.name}`, 'warning');
                setFileIndicators(fileItem, 'success');
            } else {
                throw new Error(payload.error || 'Неизвестный статус обработки');
            }
        } catch (error) {
            addToLog(`Ошибка при отправке файла ${file.name}: ${error.message}`, 'error');
            setFileIndicators(fileItem, 'idle');
        }
    }

    function setFileIndicators(fileItem, state) {
        if (!fileItem) {
            return;
        }
        const processingIcon = fileItem.querySelector('.processing-icon');
        const successIcon = fileItem.querySelector('.success-icon');

        if (processingIcon) {
            processingIcon.style.display = state === 'processing' ? 'inline-block' : 'none';
        }
        if (successIcon) {
            successIcon.style.display = state === 'success' ? 'inline-block' : 'none';
        }
    }

    function resetAllFileIndicators() {
        Array.from(fileList.querySelectorAll('.list-group-item')).forEach(item => setFileIndicators(item, 'idle'));
    }

    function appendResult(filename, rawResult, backendOrder = []) {
        const fieldOrder = deriveFieldOrder(rawResult, filename, backendOrder);
        const structureChanged = updateFieldOrder(fieldOrder);
        const normalizedResult = normalizeResult(filename, rawResult);
        accumulatedResults.push(normalizedResult);

        if (structureChanged) {
            renderResultsHeader();
            renderAllRows();
        } else {
            resultsTable.appendChild(buildResultRow(normalizedResult));
        }
    }

    function renderResultsHeader() {
        if (!resultsTableHead) {
            return;
        }
        let headerRow = resultsTableHead.querySelector('tr');
        if (!headerRow) {
            headerRow = document.createElement('tr');
            resultsTableHead.appendChild(headerRow);
        }
        const statusHeader = '<th>Статус</th>';
        const dataHeaders = orderedFields.map(field => `<th>${field}</th>`).join('');
        headerRow.innerHTML = statusHeader + dataHeaders;
    }

    function normalizeResult(filename, rawResult) {
        let normalized = {};
        if (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
            normalized = Object.assign({}, rawResult);
        }

        if (!Object.prototype.hasOwnProperty.call(normalized, 'Название_файла') && filename) {
            normalized['Название_файла'] = filename;
        }

        return normalized;
    }

    function deriveFieldOrder(rawResult, filename, backendOrder = []) {
        const order = [];

        if (Array.isArray(backendOrder) && backendOrder.length > 0) {
            backendOrder.forEach(key => {
                if (key && !order.includes(key)) {
                    order.push(key);
                }
            });
        } else if (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
            Object.keys(rawResult).forEach(key => {
                if (!order.includes(key)) {
                    order.push(key);
                }
            });
        }

        if (order.length === 0 && filename && !order.includes('Название_файла')) {
            order.push('Название_файла');
        }

        return order;
    }

    function updateFieldOrder(resultObject) {
        if (!Array.isArray(resultObject) || resultObject.length === 0) {
            return false;
        }

        const seen = new Set();
        const nextOrder = [];

        resultObject.forEach(key => {
            if (!key) {
                return;
            }
            if (!seen.has(key)) {
                nextOrder.push(key);
                seen.add(key);
            }
        });

        orderedFields.forEach(existingKey => {
            if (!seen.has(existingKey)) {
                nextOrder.push(existingKey);
                seen.add(existingKey);
            }
        });

        const changed = JSON.stringify(nextOrder) !== JSON.stringify(orderedFields);
        if (changed) {
            orderedFields = nextOrder;
        }
        return changed;
    }

    function renderAllRows() {
        resultsTable.innerHTML = '';
        accumulatedResults.forEach(result => {
            resultsTable.appendChild(buildResultRow(result));
        });
    }

    function buildResultRow(result) {
        const row = document.createElement('tr');

        const statusCell = document.createElement('td');
        statusCell.innerHTML = '<span class="badge bg-success">Обработан</span>';
        row.appendChild(statusCell);

        orderedFields.forEach(field => {
            const cell = document.createElement('td');
            const rawValue = result[field];
            const displayValue = rawValue === undefined || rawValue === null || rawValue === '' ? '-' : rawValue;
            cell.textContent = displayValue;
            if (typeof displayValue === 'string' && displayValue.length > 50) {
                cell.title = displayValue;
                cell.style.maxWidth = '200px';
                cell.style.overflow = 'hidden';
                cell.style.textOverflow = 'ellipsis';
                cell.style.whiteSpace = 'nowrap';
            }
            row.appendChild(cell);
        });

        return row;
    }

    function addToLog(message, type = 'info') {
        if (!logsContainer) {
            console.log(`[${type}] ${message}`);
            return;
        }
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }
});

const LOCAL_STORAGE_KEY = 'documentExtractorSettings';
const TEMPLATES_STORAGE_KEY = 'promptTemplates';

// Global configuration and state
let appConfig = {
    models: [],
    prompt_templates: {}
};

const FALLBACK_SETTINGS = {
    model: 'yandex/YandexGPT-5-Lite-8B-instruct-GGUF',
    customModel: '',
    apiUrl: 'http://127.0.0.1:5001/api/v1/generate',
    apiKey: '',
    prompt: '',
    maxTokens: 2000,
    temperature: 0.7
};

const injectedDefaults = window.__APP_DEFAULT_SETTINGS__ || {};
const defaultSettings = {
    model: injectedDefaults.model || FALLBACK_SETTINGS.model,
    customModel: injectedDefaults.customModel || FALLBACK_SETTINGS.customModel,
    apiUrl: injectedDefaults.apiUrl || FALLBACK_SETTINGS.apiUrl,
    apiKey: injectedDefaults.apiKey || FALLBACK_SETTINGS.apiKey,
    prompt: injectedDefaults.prompt || FALLBACK_SETTINGS.prompt,
    maxTokens: toInteger(injectedDefaults.maxTokens, FALLBACK_SETTINGS.maxTokens),
    temperature: clamp(toFloat(injectedDefaults.temperature, FALLBACK_SETTINGS.temperature), 0, 1)
};

let cachedSettings = cloneSettings(defaultSettings);

document.addEventListener('DOMContentLoaded', () => {
    const modelSelect = document.getElementById('modelSelect');
    const customModelDiv = document.getElementById('customModelDiv');
    const customModelInput = document.getElementById('customModel');
    const apiUrlInput = document.getElementById('apiUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const promptTextArea = document.getElementById('promptText');
    const maxTokensInput = document.getElementById('maxTokens');
    const temperatureSlider = document.getElementById('temperature');
    const temperatureValue = document.getElementById('temperatureValue');
    const saveSettingsBtn = document.getElementById('saveSettings');
    const resetSettingsBtn = document.getElementById('resetSettings');
    const templateSelect = document.getElementById('templateSelect');
    const templateName = document.getElementById('templateName');
    const loadTemplateBtn = document.getElementById('loadTemplateBtn');
    const deleteTemplateBtn = document.getElementById('deleteTemplateBtn');
    const saveTemplateBtn = document.getElementById('saveTemplateBtn');
    const newTemplateBtn = document.getElementById('newTemplateBtn');
    const duplicateTemplateBtn = document.getElementById('duplicateTemplateBtn');

    (async () => {
        await loadConfig();
        await loadTemplates();
        await loadSettings();
    })();

    modelSelect?.addEventListener('change', () => {
        const isCustom = modelSelect.value === 'custom';
        if (customModelDiv) {
            customModelDiv.style.display = isCustom ? 'block' : 'none';
        }
    });

    if (temperatureSlider && temperatureValue) {
        temperatureSlider.addEventListener('input', () => {
            temperatureValue.textContent = temperatureSlider.value;
        });
    }

    loadTemplateBtn?.addEventListener('click', loadSelectedTemplate);
    deleteTemplateBtn?.addEventListener('click', deleteSelectedTemplate);
    saveTemplateBtn?.addEventListener('click', saveTemplate);
    newTemplateBtn?.addEventListener('click', newTemplate);
    duplicateTemplateBtn?.addEventListener('click', duplicateTemplate);

    templateSelect?.addEventListener('change', () => {
        if (templateName) {
            templateName.value = templateSelect.value;
        }
    });

    saveSettingsBtn?.addEventListener('click', async () => {
        await saveSettings();
    });

    resetSettingsBtn?.addEventListener('click', () => {
        resetSettings();
    });

    async function loadConfig() {
        try {
            const response = await fetch('/get_config');
            if (!response.ok) {
                throw new Error(response.statusText);
            }
            const data = await response.json();
            if (data.status === 'success') {
                appConfig = data.config || appConfig;
                populateModelSelect();
                logMessage('Конфигурация загружена', 'info');
            } else {
                throw new Error(data.message || 'Не удалось загрузить конфигурацию');
            }
        } catch (error) {
            logMessage(`Ошибка при загрузке конфигурации: ${error.message}`, 'error');
        }
    }

    function populateModelSelect() {
        if (!modelSelect) {
            return;
        }

        const previousValue = modelSelect.value;
        modelSelect.innerHTML = '';

        (appConfig.models || []).forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.description ? `${model.name} - ${model.description}` : model.name;
            modelSelect.appendChild(option);
        });

        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = 'Пользовательская модель';
        modelSelect.appendChild(customOption);

        const targetValue = previousValue || cachedSettings.model || '';
        if (targetValue && !Array.from(modelSelect.options).some(option => option.value === targetValue)) {
            const restoredOption = document.createElement('option');
            restoredOption.value = targetValue;
            restoredOption.textContent = targetValue;
            modelSelect.appendChild(restoredOption);
        }
        modelSelect.value = targetValue;
    }

    async function loadTemplates() {
        if (!templateSelect) {
            return;
        }

        templateSelect.innerHTML = '<option value="">-- Выберите шаблон --</option>';
        const seen = new Set();

        Object.keys(appConfig.prompt_templates || {}).forEach(key => {
            addTemplateOption(key, key);
            seen.add(key);
        });

        const savedTemplates = readUserTemplates();
        Object.keys(savedTemplates).forEach(key => {
            const label = seen.has(key) ? `${key} (замена)` : `${key} (пользовательский)`;
            addTemplateOption(key, label);
        });
    }

    function addTemplateOption(value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        templateSelect.appendChild(option);
    }

    function loadSelectedTemplate() {
        const selected = templateSelect?.value;
        if (!selected || !promptTextArea) {
            logMessage('Выберите шаблон для загрузки', 'warning');
            return;
        }

        const content = getTemplateContent(selected);
        if (!content) {
            logMessage('Не удалось найти выбранный шаблон', 'error');
            return;
        }

        promptTextArea.value = content;
        if (templateName) {
            templateName.value = selected;
        }
        logMessage(`Шаблон "${selected}" загружен`, 'success');
    }

    function saveTemplate() {
        const name = templateName?.value?.trim();
        const text = promptTextArea?.value?.trim();

        if (!name || !text) {
            logMessage('Введите название и текст шаблона', 'error');
            return;
        }

        const templates = readUserTemplates();
        templates[name] = text;
        writeUserTemplates(templates);
        loadTemplates();
        if (templateSelect) {
            templateSelect.value = name;
        }
        logMessage(`Шаблон "${name}" сохранен`, 'success');
    }

    function deleteSelectedTemplate() {
        const selected = templateSelect?.value;
        if (!selected) {
            logMessage('Выберите шаблон для удаления', 'error');
            return;
        }

        if (appConfig.prompt_templates?.[selected]) {
            logMessage('Нельзя удалить системный шаблон', 'error');
            return;
        }

        if (!confirm(`Удалить шаблон "${selected}"?`)) {
            return;
        }

        const templates = readUserTemplates();
        delete templates[selected];
        writeUserTemplates(templates);
        loadTemplates();
        if (templateName) {
            templateName.value = '';
        }
        if (promptTextArea) {
            promptTextArea.value = '';
        }
        logMessage(`Шаблон "${selected}" удален`, 'success');
    }

    function newTemplate() {
        if (templateName) {
            templateName.value = '';
        }
        if (promptTextArea) {
            promptTextArea.value = '';
        }
        if (templateSelect) {
            templateSelect.value = '';
        }
    }

    function duplicateTemplate() {
        const selected = templateSelect?.value;
        if (!selected) {
            logMessage('Выберите шаблон для дублирования', 'error');
            return;
        }

        const content = getTemplateContent(selected);
        if (!content) {
            logMessage('Не удалось найти выбранный шаблон', 'error');
            return;
        }

        const newName = `${selected} (копия)`;
        if (templateName) {
            templateName.value = newName;
        }
        if (promptTextArea) {
            promptTextArea.value = content;
        }
        logMessage(`Шаблон продублирован как "${newName}"`, 'info');
    }

    function getTemplateContent(name) {
        const templates = readUserTemplates();
        if (templates[name]) {
            return templates[name];
        }
        return appConfig.prompt_templates?.[name];
    }

    function applySettingsToForm(settings) {
        if (modelSelect) {
            if (settings.model && !Array.from(modelSelect.options).some(option => option.value === settings.model)) {
                const option = document.createElement('option');
                option.value = settings.model;
                option.textContent = settings.model;
                modelSelect.appendChild(option);
            }
            modelSelect.value = settings.model || '';
        }
        if (customModelInput) {
            customModelInput.value = settings.customModel || '';
        }
        if (apiUrlInput) {
            apiUrlInput.value = settings.apiUrl || '';
        }
        if (apiKeyInput) {
            apiKeyInput.value = settings.apiKey || '';
        }
        if (promptTextArea) {
            promptTextArea.value = settings.prompt || '';
        }
        if (maxTokensInput) {
            maxTokensInput.value = settings.maxTokens;
        }
        if (temperatureSlider) {
            temperatureSlider.value = settings.temperature;
        }
        if (temperatureValue) {
            temperatureValue.textContent = settings.temperature;
        }
        if (customModelDiv) {
            customModelDiv.style.display = settings.model === 'custom' ? 'block' : 'none';
        }
    }

    function collectSettingsFromForm() {
        return normalizeSettings({
            model: modelSelect ? modelSelect.value : defaultSettings.model,
            customModel: customModelInput ? customModelInput.value : '',
            apiUrl: apiUrlInput ? apiUrlInput.value : defaultSettings.apiUrl,
            apiKey: apiKeyInput ? apiKeyInput.value : '',
            prompt: promptTextArea ? promptTextArea.value : defaultSettings.prompt,
            maxTokens: maxTokensInput ? maxTokensInput.value : defaultSettings.maxTokens,
            temperature: temperatureSlider ? temperatureSlider.value : defaultSettings.temperature
        });
    }

    async function loadSettings() {
        let settings = await fetchServerSettings();
        if (settings) {
            persistLocalSettings(settings);
            logMessage('Настройки загружены с сервера', 'info');
        } else {
            const local = readLocalSettings();
            if (local) {
                settings = normalizeSettings(local);
                logMessage('Используются настройки из браузера', 'warning');
            } else {
                settings = cloneSettings(defaultSettings);
                logMessage('Используются значения по умолчанию', 'warning');
            }
        }

        cachedSettings = cloneSettings(settings);
        applySettingsToForm(settings);
    }

    async function saveSettings() {
        try {
            const settings = collectSettingsFromForm();
            persistLocalSettings(settings);
            cachedSettings = cloneSettings(settings);
            logMessage('Настройки сохранены', 'success');
            await syncSettingsWithServer(settings);
        } catch (error) {
            logMessage(`Ошибка при сохранении настроек: ${error.message}`, 'error');
        }
    }

    async function syncSettingsWithServer(settings) {
        try {
            const response = await fetch('/save_settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(settings)
            });

            const data = await response.json();
            if (data.status === 'success') {
                logMessage('Настройки синхронизированы с сервером', 'success');
            } else {
                throw new Error(data.message || 'Не удалось синхронизировать настройки');
            }
        } catch (error) {
            logMessage(`Предупреждение: не удалось синхронизировать с сервером (${error.message})`, 'warning');
        }
    }

    function resetSettings() {
        applySettingsToForm(defaultSettings);
        persistLocalSettings(defaultSettings);
        cachedSettings = cloneSettings(defaultSettings);
        logMessage('Настройки сброшены к значениям по умолчанию', 'info');
        syncSettingsWithServer(defaultSettings);
    }

    window.loadConfig = loadConfig;
    window.loadSettings = loadSettings;
    window.saveSettings = saveSettings;
    window.resetSettings = resetSettings;
});

async function fetchServerSettings() {
    try {
        const response = await fetch('/get_settings');
        if (!response.ok) {
            throw new Error(response.statusText);
        }
        const data = await response.json();
        if (data.status === 'success' && data.settings) {
            return normalizeSettings(data.settings);
        }
        logMessage('Сервер не вернул настройки', 'warning');
    } catch (error) {
        logMessage(`Не удалось загрузить настройки с сервера: ${error.message}`, 'warning');
    }
    return null;
}

function normalizeSettings(settings = {}) {
    return {
        model: settings.model || defaultSettings.model,
        customModel: settings.customModel || '',
        apiUrl: settings.apiUrl || defaultSettings.apiUrl,
        apiKey: settings.apiKey || '',
        prompt: settings.prompt || defaultSettings.prompt,
        maxTokens: toInteger(settings.maxTokens, defaultSettings.maxTokens),
        temperature: clamp(toFloat(settings.temperature, defaultSettings.temperature), 0, 1)
    };
}

function persistLocalSettings(settings) {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
        logMessage(`Не удалось сохранить настройки в браузере: ${error.message}`, 'warning');
    }
}

function readLocalSettings() {
    try {
        const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
        return saved ? JSON.parse(saved) : null;
    } catch (error) {
        logMessage(`Не удалось прочитать настройки из браузера: ${error.message}`, 'warning');
        return null;
    }
}

function readUserTemplates() {
    try {
        return JSON.parse(localStorage.getItem(TEMPLATES_STORAGE_KEY) || '{}');
    } catch {
        return {};
    }
}

function writeUserTemplates(data) {
    try {
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
        logMessage(`Не удалось сохранить шаблон в браузере: ${error.message}`, 'warning');
    }
}

function toInteger(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function cloneSettings(settings) {
    return JSON.parse(JSON.stringify(settings));
}

function logMessage(message, type = 'info') {
    if (typeof window.addToLog === 'function') {
        window.addToLog(message, type);
    } else {
        console.log(`[${type}] ${message}`);
    }
}

function getCurrentSettings() {
    const local = readLocalSettings();
    const source = cachedSettings || (local ? normalizeSettings(local) : defaultSettings);
    return cloneSettings(source);
}

window.getCurrentSettings = getCurrentSettings;

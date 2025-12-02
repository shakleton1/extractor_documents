import os
from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
from file_processing_backend.text_extractor import process_document
import json

app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True # <--- Добавь это
app.jinja_env.auto_reload = True

# Настройка папки для загрузки файлов
UPLOAD_FOLDER = 'uploads'
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Список обработанных файлов
processed_files = []

# Файл для хранения настроек
SETTINGS_FILE = 'settings.json'

# ==============================================================================
# MEGA-PROMPT CONFIGURATION
# ==============================================================================
default_settings = {
    'model': 'yandex/YandexGPT-5-Lite-8B-instruct-GGUF', 
    'customModel': '',
    'apiUrl': 'http://127.0.0.1:5001/api/v1/generate',
    'apiKey': '',
    'maxTokens': 8000, # Увеличено для запаса на большие ответы
    'temperature': 0.0, # Строго 0 для фактов
     'prompt': '''
################################################################################
# ПРОТОКОЛ: DOC_EXTRACT_QA_2025
# РОЛЬ: Senior Invoice QA (Российские первичные документы)
# ЦЕЛЬ: Вернуть JSON строго по схеме с точностью ≥ 95%.
################################################################################

1. Ты читаешь сырой OCR и блок REGEX HINTS (ИНН/КПП). Если данные расходятся,
    доверяй подсказкам и числам, встречающимся несколько раз в документе.
2. Заполняй только то, что явно присутствует. Если поле отсутствует — пиши
    "не указано" (точно такая строка).
3. Никогда не меняй смысл: не придумывай ИНН, даты или адреса.

================================================================================
ЛОГИКА ПОЛЕЙ
================================================================================

- ИСПОЛНИТЕЛЬ = Продавец/Поставщик. ИНН/КПП и адрес бери из блока продавца.
- ЗАКАЗЧИК = Покупатель/Плательщик. Используй блок покупателя.
- Игнорируй грузоотправителя/грузополучателя, если там "он же".
- "Название_файла" заполняй исходным именем файла, если оно присутствует во
  входном тексте; иначе оставь "не указано".

================================================================================
ПРАВИЛА ЧИСТКИ
================================================================================

- Склеивай адрес в одну строку, удаляя "Адрес:" и лишние переносы.
- Нормализуй цифры: буква "О" → "0", "з" → "3".
- Номер документа берётся после символа "№" до ближайшей даты / перевода строки.
- Дата: сохраняй формат оригинала (дд.мм.гггг или "24 октября 2023").
- ИНН всегда 10 или 12 цифр, КПП — 9 цифр. Если найдено одно число → это ИНН,
  КПП ставь "не указано".

================================================================================
ФОРМАТ ОТВЕТА
================================================================================

Верни JSON **без** Markdown. Порядок ключей фиксированный:
{
"Название_файла": "string",
"Тип_документа": "string",
"Номер_документа": "string",
"Дата_документа": "string",
"Наименование_заказчика": "string",
"Наименование_исполнителя": "string",
"ИНН_заказчика": "string",
"ИНН_исполнителя": "string",
"КПП_заказчика": "string",
"КПП_исполнителя": "string",
"Адрес_заказчика": "string",
"Адрес_исполнителя": "string"
}

{text}
''',
    'templates': {
        'JSON Only': '''Твоя задача — извлечь данные в JSON.

    ПРАВИЛА:
    1. Исполнитель = Продавец. Заказчик = Покупатель.
    2. ИНН/КПП разделяй ("7701/7702" -> ИНН: 7701, КПП: 7702).
    3. Адреса в одну строку. Если значение не найдено — пиши "не указано".
    4. Строго соблюдай порядок ключей:
    {
    "Название_файла": "string",
    "Тип_документа": "string",
    "Номер_документа": "string",
    "Дата_документа": "string",
    "Наименование_заказчика": "string",
    "Наименование_исполнителя": "string",
    "ИНН_заказчика": "string",
    "ИНН_исполнителя": "string",
    "КПП_заказчика": "string",
    "КПП_исполнителя": "string",
    "Адрес_заказчика": "string",
    "Адрес_исполнителя": "string"
    }

    ТЕКСТ:
    {text}'''
    }
}

def load_settings():
    """Загружает настройки из файла"""
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f"Ошибка при загрузке настроек: {e}")
    return default_settings.copy()

def save_settings_to_file(settings):
    """Сохраняет настройки в файл"""
    try:
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=4)
        return True
    except Exception as e:
        print(f"Ошибка при сохранении настроек: {e}")
        return False

@app.route('/')
def index():
    return render_template(
        'index.html',
        processed_files=processed_files,
        default_settings=default_settings
    )

@app.route('/save_settings', methods=['POST'])
def save_settings():
    """Сохраняет настройки"""
    try:
        settings = request.get_json()
        if save_settings_to_file(settings):
            return jsonify({'status': 'success', 'message': 'Настройки сохранены'})
        else:
            return jsonify({'status': 'error', 'message': 'Ошибка при сохранении настроек'}), 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/get_settings', methods=['GET'])
def get_settings():
    """Возвращает текущие настройки"""
    try:
        settings = load_settings()
        return jsonify({'status': 'success', 'settings': settings})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/get_config', methods=['GET'])
def get_config():
    """Возвращает конфигурацию (модели, шаблоны)"""
    try:
        config_file = 'config.json'
        if os.path.exists(config_file):
            with open(config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
        else:
            config = {
                "models": [
                    {"id": "yandex/YandexGPT-5-Lite-8B-instruct-GGUF", "name": "YandexGPT-5-Lite-8B", "description": "Облегченная модель YandexGPT"}
                ],
                "prompt_templates": {}
            }
        return jsonify({'status': 'success', 'config': config})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Файл не выбран'}), 400
    
    if file:
        filename = secure_filename(file.filename)
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)
        
        # Получаем настройки
        settings = None
        if 'settings' in request.form:
            try:
                settings = json.loads(request.form['settings'])
            except:
                pass
        
        if not settings:
            settings = load_settings()
        
        if filename in processed_files:
            return jsonify({
                'message': 'Файл уже был обработан ранее',
                'filename': filename,
                'status': 'already_processed'
            })
        
        try:
            # === ЗАПУСК ОБРАБОТКИ ===
            result = process_document(filepath, settings)
            
            if result:
                processed_files.append(filename)
                
                # Сохраняем результат
                result_filename = f"{os.path.splitext(filename)[0]}_result.json"
                result_path = os.path.join(app.config['UPLOAD_FOLDER'], result_filename)
                with open(result_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False, indent=4)

                result_order = list(result.keys()) if isinstance(result, dict) else []
                
                return jsonify({
                    'message': 'Файл успешно обработан',
                    'filename': filename,
                    'result': result,
                    'result_order': result_order,
                    'status': 'success'
                })
            else:
                return jsonify({
                    'error': 'Нейросеть не вернула корректные данные. Попробуйте другой скан.',
                    'filename': filename,
                    'status': 'error'
                }), 500
                
        except Exception as e:
            return jsonify({
                'error': f'Ошибка сервера: {str(e)}',
                'filename': filename,
                'status': 'error'
            }), 500

if __name__ == '__main__':
    app.run(debug=True)

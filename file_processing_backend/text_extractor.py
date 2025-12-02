import fitz  # PyMuPDF
from PIL import Image
import pytesseract
import os
import requests
from pdf2image import convert_from_path
import json
import tempfile
import re
import cv2
import numpy as np

# =========================================================
# КОНФИГУРАЦИЯ СИСТЕМНЫХ ПУТЕЙ
# =========================================================
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
POPLER_PATH = r'C:\Program Files\poppler-24.08.0\Library\bin'

# Конфигурация Tesseract
TESSERACT_CONFIGS = [
    r'--oem 1 --psm 6 -c preserve_interword_spaces=1',
    r'--oem 3 --psm 4'
]
LANGUAGES = 'rus+eng'

DEFAULT_GENERATION_PARAMS = {
    "max_context_length": 2048,
    "max_length": 512,
    "quiet": False,
    "rep_pen": 1.1,
    "rep_pen_range": 256,
    "rep_pen_slope": 1,
    "temperature": 0.5,
    "tfs": 1,
    "top_a": 0,
    "top_k": 100,
    "top_p": 0.9,
    "typical": 1
}


def _coerce_number(value, fallback):
    try:
        return type(fallback)(value)
    except (TypeError, ValueError):
        return fallback


def build_generation_payload(final_prompt, settings):
    payload = DEFAULT_GENERATION_PARAMS.copy()
    payload['prompt'] = final_prompt

    max_length = _coerce_number(settings.get('maxTokens'), payload['max_length'])
    payload['max_length'] = max_length

    explicit_context = settings.get('maxContextLength')
    if explicit_context is not None:
        max_context_length = _coerce_number(explicit_context, payload['max_context_length'])
    else:
        max_context_length = max(payload['max_context_length'], max_length)
    payload['max_context_length'] = max_context_length

    payload['temperature'] = _coerce_number(settings.get('temperature'), payload['temperature'])

    override_keys = [
        'quiet',
        'rep_pen',
        'rep_pen_range',
        'rep_pen_slope',
        'tfs',
        'top_a',
        'top_k',
        'top_p',
        'typical'
    ]

    for key in override_keys:
        if key in settings:
            payload[key] = settings[key]

    return payload

def save_debug_file(original_path, suffix, content, mode='w'):
    """Помощник для сохранения отладочных файлов"""
    try:
        base_path = os.path.splitext(original_path)[0]
        debug_path = f"{base_path}_{suffix}"
        
        if mode == 'w': # Текстовый файл
            with open(debug_path, 'w', encoding='utf-8') as f:
                f.write(content)
        elif mode == 'wb': # Бинарный файл (картинка)
            with open(debug_path, 'wb') as f:
                f.write(content)
        elif mode == 'img': # PIL Image
            content.save(debug_path)
            
        print(f"[DEBUG] Сохранен файл: {os.path.basename(debug_path)}")
    except Exception as e:
        print(f"[DEBUG] Ошибка сохранения {suffix}: {e}")

class ImageProcessor:
    """Класс для улучшения качества сканов перед OCR"""
    
    @staticmethod
    def _scale_for_ocr(gray_img):
        max_side = 2200
        h, w = gray_img.shape[:2]
        longest = max(h, w)
        if longest >= max_side:
            return gray_img
        scale = min(max_side / float(longest), 2.5)
        return cv2.resize(gray_img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    @staticmethod
    def _prepare_binary(gray_img):
        """Готовит инвертированное двоичное изображение для поиска наклона"""
        blur = cv2.GaussianBlur(gray_img, (5, 5), 0)
        _, thresh = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        return cv2.bitwise_not(thresh)

    @staticmethod
    def _estimate_angle_hough(binary_img):
        height, width = binary_img.shape[:2]
        edges = cv2.Canny(binary_img, 50, 150, apertureSize=3)
        vote_threshold = max(int(0.03 * min(height, width)), 100)
        lines = cv2.HoughLines(edges, 1, np.pi / 1800, vote_threshold)

        if lines is None:
            return None

        angles = []
        for line in lines:
            rho, theta = line[0]
            angle = np.degrees(theta) - 90.0
            if -45 < angle < 45:
                angles.append(angle)

        if not angles:
            return None

        return float(np.median(angles))

    @staticmethod
    def _estimate_angle_probabilistic(binary_img):
        height, width = binary_img.shape[:2]
        edges = cv2.Canny(binary_img, 50, 150, apertureSize=3)
        min_line_length = max(int(width * 0.35), 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=120,
                                minLineLength=min_line_length, maxLineGap=20)

        if lines is None:
            return None

        angles = []
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
            if -45 < angle < 45:
                angles.append(angle)

        if not angles:
            return None

        return float(np.median(angles))

    @staticmethod
    def _estimate_angle_components(binary_img):
        coords = cv2.findNonZero(binary_img)
        if coords is None or len(coords) < 500:
            return None

        rect = cv2.minAreaRect(coords)
        (width, height) = rect[1]
        angle = rect[-1]

        if width < height:
            angle = angle + 90

        if angle < -45:
            angle += 90
        if angle > 45:
            angle -= 90

        if -45 <= angle <= 45:
            return float(angle)

        return None

    @staticmethod
    def _estimate_skew_angle(gray_img):
        """Комплексно оценивает угол наклона через разные детекторы"""
        binary = ImageProcessor._prepare_binary(gray_img)

        angles = []
        for detector in (
            ImageProcessor._estimate_angle_hough,
            ImageProcessor._estimate_angle_probabilistic,
            ImageProcessor._estimate_angle_components,
        ):
            angle = detector(binary)
            if angle is not None:
                angles.append(angle)

        if not angles:
            return 0.0

        median = float(np.median(angles))
        filtered = [a for a in angles if abs(a - median) <= 2.5]
        if filtered:
            return float(np.mean(filtered))

        return median

    @staticmethod
    def deskew_image(pil_image):
        """Выравнивает наклон и возвращает угол"""
        try:
            np_img = np.array(pil_image)
            if np_img.ndim == 2:
                gray = np_img
            else:
                if np_img.shape[2] == 4:
                    gray = cv2.cvtColor(np_img, cv2.COLOR_RGBA2GRAY)
                else:
                    gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)

            angle = ImageProcessor._estimate_skew_angle(gray)

            if abs(angle) < 0.1 or abs(angle) > 30:
                return pil_image.copy(), angle

            (h, w) = gray.shape[:2]
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, angle, 1.0)
            rotated = cv2.warpAffine(np_img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            return Image.fromarray(rotated), angle
        except Exception:
            return pil_image.copy(), None

    @staticmethod
    def enhance_quality(pil_image, debug_save_path=None):
        """Улучшает резкость и контраст + сохраняет дебаг картинку"""
        # 1. Выравнивание
        image, detected_angle = ImageProcessor.deskew_image(pil_image)
        
        # 2. Конвертация в массив
        img_np = np.array(image)
        if len(img_np.shape) == 3:
            img_np = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)

        # 3. Нормализация размера и шумоподавление
        img_np = ImageProcessor._scale_for_ocr(img_np)
        img_np = cv2.fastNlMeansDenoising(img_np, None, h=15, templateWindowSize=7, searchWindowSize=21)

        # 4. Повышение контраста и локальная нормализация
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        img_np = clahe.apply(img_np)

        # 5. Бинаризация и зачистка артефактов
        processed = cv2.adaptiveThreshold(
            img_np, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 10
        )
        processed = cv2.medianBlur(processed, 3)
        
        result_img = Image.fromarray(processed)
        
        # Сохраняем первую страницу, чтобы юзер видел, что видит робот
        if debug_save_path:
            try:
                result_img.save(debug_save_path)
                print(f"[DEBUG] Сохранена обработанная картинка: {debug_save_path}")
            except Exception as e:
                print(f"Ошибка сохранения дебаг-картинки: {e}")

            if detected_angle is not None:
                try:
                    angle_log_path = f"{os.path.splitext(debug_save_path)[0]}_deskew_angle.txt"
                    with open(angle_log_path, 'w', encoding='utf-8') as angle_file:
                        angle_file.write(f"{detected_angle:.3f}")
                except Exception as angle_err:
                    print(f"Ошибка сохранения угла наклона: {angle_err}")

        return result_img

def get_regex_hints(text):
    """Ищет в тексте все числа, похожие на ИНН и КПП."""
    hints = []
    inns = list(set(re.findall(r'\b\d{10}\b|\b\d{12}\b', text)))
    if inns:
        hints.append(f"Найденные ИНН: {', '.join(inns)}")
    kpps = list(set(re.findall(r'\b\d{9}\b', text)))
    if kpps:
        hints.append(f"Найденные КПП: {', '.join(kpps)}")
    return "\n".join(hints)


def _ocr_text_score(text):
    cleaned = re.sub(r'[^0-9A-Za-zА-Яа-я]', '', text or '')
    return len(cleaned)


def run_multi_pass_ocr(processed_img, original_img):
    candidates = []
    for pil_image in (processed_img, original_img):
        if pil_image is None:
            continue
        for config in TESSERACT_CONFIGS:
            try:
                text = pytesseract.image_to_string(pil_image, lang=LANGUAGES, config=config)
                candidates.append(text)
            except pytesseract.TesseractError as e:
                print(f"[WARNING] OCR fail for config {config}: {e}")

    if not candidates:
        return ''

    candidates.sort(key=_ocr_text_score, reverse=True)
    return candidates[0]

def extract_text_from_pdf(pdf_path):
    """Извлекает текст из PDF и сохраняет логи"""
    try:
        print(f"--- Начало OCR для: {os.path.basename(pdf_path)} ---")
        
        with tempfile.TemporaryDirectory() as temp_dir:
            images = convert_from_path(pdf_path, poppler_path=POPLER_PATH, dpi=300)
            full_text = []

            for i, image in enumerate(images):
                print(f"Обработка страницы {i+1}...")
                
                # Формируем путь для сохранения дебаг-картинки (только для 1 страницы)
                debug_img_path = None
                if i == 0: 
                    debug_img_path = f"{os.path.splitext(pdf_path)[0]}_debug_processed_view.jpg"

                # Обработка картинки
                processed_img = ImageProcessor.enhance_quality(image, debug_img_path)
                
                # Tesseract: пробуем несколько конфигураций и выбираем лучшую
                text = run_multi_pass_ocr(processed_img, image)
                full_text.append(f"--- СТРАНИЦА {i+1} ---\n{text}")

            combined_text = "\n".join(full_text)
            
            # === ГЛАВНОЕ: СОХРАНЯЕМ ТЕКСТ В ФАЙЛ ===
            save_debug_file(pdf_path, "raw_ocr.txt", combined_text)
            
            if not combined_text.strip():
                print("[WARNING] Tesseract вернул пустой текст! Проверьте debug_processed_view.jpg")

            return combined_text
    except Exception as e:
        print(f"[CRITICAL ERROR] OCR упал: {str(e)}")
        return None

def process_text_with_neural_network(text, settings, pdf_path_for_debug=""):
    """Отправка в LLM"""
    try:
        hints_block = get_regex_hints(text)
        final_input_text = f"REGEX HINTS:\n{hints_block}\n\nTEXT:\n{text}"
        
        # Подготовка промта
        raw_prompt = settings.get('prompt', '')
        if '{text}' in raw_prompt:
            final_prompt = raw_prompt.replace('{text}', final_input_text)
        else:
            final_prompt = f"{raw_prompt}\n\n{final_input_text}"

        # === СОХРАНЯЕМ ПОЛНЫЙ ПРОМТ ===
        # Чтобы ты видел, что именно уходит в нейросеть
        if pdf_path_for_debug:
            save_debug_file(pdf_path_for_debug, "final_prompt_sent.txt", final_prompt)

        url = settings.get('apiUrl') or 'http://127.0.0.1:5001/api/v1/generate'
        headers = {"Content-Type": "application/json"}
        if settings.get('apiKey'):
            headers["Authorization"] = f"Bearer {settings['apiKey']}"

        data = build_generation_payload(final_prompt, settings)

        print("Отправка запроса в нейросеть...")
        response = requests.post(url, json=data, headers=headers)
        
        # Логируем ошибку, если API ответил не 200
        if response.status_code != 200:
             error_msg = f"API Error {response.status_code}: {response.text}"
             if pdf_path_for_debug:
                 save_debug_file(pdf_path_for_debug, "api_error.txt", error_msg)
             return {"error": error_msg}

        response_json = response.json()
        results = response_json.get('results') or []
        if not results or 'text' not in results[0]:
            raise ValueError('API вернул неожиданный ответ без текста')
        content = results[0].get('text', '')
        
        # === СОХРАНЯЕМ СЫРОЙ ОТВЕТ НЕЙРОСЕТИ ===
        if pdf_path_for_debug:
            save_debug_file(pdf_path_for_debug, "raw_llm_response.txt", content)

        # Парсинг JSON
        match = re.search(r'\{.*\}', content, re.DOTALL)
        if match:
            json_str = match.group(0)
            json_str = re.sub(r',\s*}', '}', json_str) # Чистим запятые
            return json.loads(json_str)
        else:
            return json.loads(content)

    except Exception as e:
        print(f"Ошибка AI: {str(e)}")
        if pdf_path_for_debug:
            save_debug_file(pdf_path_for_debug, "crash_log.txt", str(e))
        return {"error": "Processing failed", "details": str(e)}

def process_document(pdf_path, settings=None):
    """Точка входа"""
    text = extract_text_from_pdf(pdf_path)
    
    # Если текст пустой, нет смысла слать в LLM
    if not text or len(text.strip()) < 10:
        return {"error": "OCR не смог прочитать текст. Проверьте _raw_ocr.txt и _debug.jpg"}
    
    if not settings:
        settings = {'prompt': '{text}'} 

    # Передаем путь к файлу, чтобы функции могли сохранять логи рядом
    result = process_text_with_neural_network(text, settings, pdf_path_for_debug=pdf_path)
    return result

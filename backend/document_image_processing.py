"""Image preprocessing for document restoration and enhancement.

Uses OpenCV (headless) and Pillow for:
  - Denoising
  - Contrast / brightness correction
  - Deskewing
  - Sharpening
  - Thresholding / binarization
  - Background cleanup
  - Resolution enhancement

Every function takes a numpy array (BGR) and returns one.  The caller
decides which operations to apply based on the document condition.
"""

from __future__ import annotations

import io
import math
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


# ── Helpers ──────────────────────────────────────────────────────

def _to_pil(img: np.ndarray) -> Image.Image:
    """Convert a BGR numpy array to a PIL Image (RGB)."""
    return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))


def _from_pil(pil_img: Image.Image) -> np.ndarray:
    """Convert a PIL Image (RGB) to a BGR numpy array."""
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


def load_image(path: str | Path) -> np.ndarray:
    """Load an image from disk.  Handles common formats."""
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Could not read image: {path}")
    return img


def save_image(img: np.ndarray, path: str | Path, quality: int = 92) -> str:
    """Write an image to disk.  Returns the saved path."""
    p = Path(path)
    ext = p.suffix.lower()
    params = []
    if ext in (".jpg", ".jpeg"):
        params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    elif ext == ".png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
    cv2.imwrite(str(p), img, params)
    return str(p)


def image_to_bytes(img: np.ndarray, fmt: str = ".png") -> bytes:
    """Encode image to bytes in the given format."""
    _, buf = cv2.imencode(fmt, img)
    return buf.tobytes()


def bytes_to_image(data: bytes) -> np.ndarray:
    """Decode image bytes to a numpy array."""
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


# ── 1. Denoising ────────────────────────────────────────────────

def denoise(img: np.ndarray, strength: int = 10) -> np.ndarray:
    """Remove image noise using Non-Local Means Denoising."""
    return cv2.fastNlMeansDenoisingColored(
        img, None, h=strength, hForColoredImages=strength,
        templateWindowSize=7, searchWindowSize=21,
    )


# ── 2. Contrast Enhancement ─────────────────────────────────────

def enhance_contrast(img: np.ndarray, clip_limit: float = 2.5, tile_size: int = 8) -> np.ndarray:
    """Adaptive histogram equalization (CLAHE) on the L channel."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_channel, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(tile_size, tile_size))
    l_channel = clahe.apply(l_channel)
    lab = cv2.merge([l_channel, a, b])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


# ── 3. Brightness / Illumination Correction ─────────────────────

def correct_brightness(img: np.ndarray, factor: float = 1.3) -> np.ndarray:
    """Adjust brightness using Pillow.  factor > 1 = brighter."""
    pil = _to_pil(img)
    enhancer = ImageEnhance.Brightness(pil)
    pil = enhancer.enhance(factor)
    return _from_pil(pil)


def correct_uneven_lighting(img: np.ndarray, kernel_size: int = 51) -> np.ndarray:
    """Remove uneven lighting / shadows using a large Gaussian blur baseline."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (kernel_size, kernel_size), 0)
    # Divide the original by the background to even out the lighting
    corrected = cv2.divide(gray, blur, scale=255)
    return cv2.cvtColor(corrected, cv2.COLOR_GRAY2BGR)


# ── 4. Deskewing / Alignment ────────────────────────────────────

def detect_skew_angle(img: np.ndarray) -> float:
    """Detect the skew angle using the Hough Line Transform."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180, threshold=100,
        minLineLength=80, maxLineGap=10,
    )
    if lines is None or len(lines) == 0:
        return 0.0

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = math.degrees(math.atan2(y2 - y1, x2 - x1))
        # Only consider near-horizontal lines (text lines)
        if -45 < angle < 45:
            angles.append(angle)

    if not angles:
        return 0.0
    return float(np.median(angles))


def deskew(img: np.ndarray, angle: Optional[float] = None) -> np.ndarray:
    """Rotate the image to correct skew.  Auto-detects angle if not given."""
    if angle is None:
        angle = detect_skew_angle(img)
    if abs(angle) < 0.3:
        return img  # negligible skew

    h, w = img.shape[:2]
    center = (w // 2, h // 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)

    # Compute new bounding box to avoid cutting corners
    cos_a = abs(matrix[0, 0])
    sin_a = abs(matrix[0, 1])
    new_w = int(h * sin_a + w * cos_a)
    new_h = int(h * cos_a + w * sin_a)
    matrix[0, 2] += (new_w - w) / 2
    matrix[1, 2] += (new_h - h) / 2

    return cv2.warpAffine(
        img, matrix, (new_w, new_h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


# ── 5. Sharpening ───────────────────────────────────────────────

def sharpen(img: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Sharpen the image using an unsharp mask."""
    blurred = cv2.GaussianBlur(img, (0, 0), 3)
    sharpened = cv2.addWeighted(img, 1.0 + strength, blurred, -strength, 0)
    return sharpened


def sharpen_pillow(img: np.ndarray, factor: float = 2.0) -> np.ndarray:
    """Sharpen using Pillow's sharpness enhancer."""
    pil = _to_pil(img)
    enhancer = ImageEnhance.Sharpness(pil)
    pil = enhancer.enhance(factor)
    return _from_pil(pil)


# ── 6. Thresholding / Binarization ──────────────────────────────

def adaptive_threshold(img: np.ndarray, block_size: int = 15, c: int = 8) -> np.ndarray:
    """Adaptive thresholding for documents with uneven backgrounds."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, block_size, c,
    )
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def otsu_threshold(img: np.ndarray) -> np.ndarray:
    """Otsu's binarization — best for documents with bimodal histograms."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


# ── 7. Resolution Enhancement ───────────────────────────────────

def upscale(img: np.ndarray, scale: float = 2.0) -> np.ndarray:
    """Upscale the image using Lanczos interpolation."""
    h, w = img.shape[:2]
    new_w, new_h = int(w * scale), int(h * scale)
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)


# ── 8. Background Cleanup ───────────────────────────────────────

def remove_background_noise(img: np.ndarray) -> np.ndarray:
    """Remove background stains and discoloration using morphological ops."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Use a large morphological opening to estimate the background
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
    bg = cv2.morphologyEx(gray, cv2.MORPH_OPEN, kernel, iterations=2)
    # Subtract background to leave just the text
    diff = cv2.subtract(bg, gray)
    _, clean = cv2.threshold(diff, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return cv2.cvtColor(clean, cv2.COLOR_GRAY2BGR)


# ── Composite Pipeline ──────────────────────────────────────────

def assess_image_quality(img: np.ndarray) -> dict:
    """Assess image quality metrics to decide which enhancements to apply.

    Returns a dict with quality indicators.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Brightness
    mean_brightness = float(np.mean(gray))

    # Contrast
    std_dev = float(np.std(gray))

    # Noise estimate (Laplacian variance)
    laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # Skew angle
    skew_angle = detect_skew_angle(img)

    # Resolution category
    resolution = "low" if max(h, w) < 800 else "medium" if max(h, w) < 2000 else "high"

    return {
        "width": w,
        "height": h,
        "mean_brightness": mean_brightness,
        "contrast_std": std_dev,
        "sharpness_laplacian": laplacian_var,
        "skew_angle": skew_angle,
        "resolution": resolution,
        "is_dark": mean_brightness < 100,
        "is_bright": mean_brightness > 200,
        "is_low_contrast": std_dev < 40,
        "is_blurry": laplacian_var < 100,
        "is_noisy": laplacian_var > 2000 and std_dev < 60,
        "is_skewed": abs(skew_angle) > 1.0,
        "is_low_res": resolution == "low",
    }


def auto_enhance(img: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """Automatically select and apply appropriate enhancements based on
    the document image's actual condition.

    Returns (enhanced_image, list_of_operations_applied).
    """
    quality = assess_image_quality(img)
    operations: list[str] = []
    result = img.copy()

    # Step 1: Upscale low-res images first
    if quality["is_low_res"]:
        result = upscale(result, scale=2.0)
        operations.append("Resolution enhancement (2× upscale)")

    # Step 2: Deskew
    if quality["is_skewed"]:
        angle = quality["skew_angle"]
        result = deskew(result, angle)
        operations.append(f"Deskew correction ({angle:.1f}°)")

    # Step 3: Denoise (before other enhancements)
    if quality["is_noisy"]:
        result = denoise(result, strength=12)
        operations.append("Noise reduction")

    # Step 4: Fix uneven lighting
    if quality["is_dark"] or quality["is_bright"]:
        result = correct_uneven_lighting(result)
        operations.append("Illumination correction")
    elif quality["mean_brightness"] < 120:
        result = correct_brightness(result, factor=1.3)
        operations.append("Brightness adjustment")

    # Step 5: Enhance contrast
    if quality["is_low_contrast"]:
        result = enhance_contrast(result, clip_limit=3.0)
        operations.append("Contrast enhancement (CLAHE)")

    # Step 6: Sharpen blurry images
    if quality["is_blurry"]:
        result = sharpen(result, strength=0.8)
        operations.append("Sharpening (unsharp mask)")

    if not operations:
        # Even good images benefit from mild enhancement
        result = enhance_contrast(result, clip_limit=1.5)
        result = sharpen(result, strength=0.3)
        operations.append("Mild contrast and sharpness tuning")

    return result, operations


def create_clean_scan(img: np.ndarray) -> np.ndarray:
    """Create a clean, high-contrast version optimised for OCR readability.

    This is a separate output from auto_enhance; it may lose colour or
    visual fidelity in exchange for text readability.
    """
    result = img.copy()

    # Upscale small images
    h, w = result.shape[:2]
    if max(h, w) < 1200:
        result = upscale(result, scale=2.0)

    # Deskew
    angle = detect_skew_angle(result)
    if abs(angle) > 0.5:
        result = deskew(result, angle)

    # Denoise lightly
    result = denoise(result, strength=6)

    # Even out lighting
    result = correct_uneven_lighting(result)

    # Adaptive threshold for maximum text/background separation
    result = adaptive_threshold(result, block_size=15, c=8)

    return result


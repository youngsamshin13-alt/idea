#!/usr/bin/env python3
"""딱새우 꾸어칩 상세페이지 작업용 PSD 템플릿 생성기.

포토샵 파일을 쓰는 외부 라이브러리 없이 PSD 바이너리를 직접 작성합니다.
레이어는 PackBits(RLE)로 압축하므로 단색 위주인 템플릿은 파일이 작게 나옵니다.
한글 레이어 이름은 'luni' 블록에 UTF-16으로 넣어 포토샵에서 그대로 보입니다.

실행:  python3 make_psd.py
결과:  같은 폴더에 .psd 두 개
"""

import struct

# ── 브랜드 팔레트 (index.html의 :root 토큰과 동일) ───────────────────────────
RED = (0xE1, 0x2B, 0x20)
RED_DEEP = (0xA8, 0x18, 0x11)
YELLOW = (0xFF, 0xC7, 0x2C)
CREAM = (0xFB, 0xF4, 0xEC)
GOLD = (0xD8, 0x9A, 0x4E)
INK = (0x1F, 0x1A, 0x18)
WHITE = (0xFF, 0xFF, 0xFF)


def packbits(data: bytes) -> bytes:
    """PSD가 쓰는 PackBits RLE 압축."""
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        # 같은 바이트가 3개 이상 이어지면 런 길이로 인코딩
        run = 1
        while i + run < n and data[i + run] == data[i] and run < 128:
            run += 1
        if run >= 3:
            out.append(257 - run)
            out.append(data[i])
            i += run
            continue
        # 아니면 리터럴 구간을 모은다
        start = i
        lit = 0
        while i < n and lit < 128:
            run = 1
            while i + run < n and data[i + run] == data[i] and run < 3:
                run += 1
            if run >= 3:
                break
            i += 1
            lit += 1
        out.append(lit - 1)
        out += data[start:start + lit]
    return bytes(out)


def encode_channel(plane: bytes, width: int, height: int):
    """한 채널을 행 단위로 압축하고 (행 길이 표, 압축 데이터)를 돌려준다."""
    counts = bytearray()
    body = bytearray()
    for y in range(height):
        row = plane[y * width:(y + 1) * width]
        packed = packbits(row)
        counts += struct.pack('>H', len(packed))
        body += packed
    return bytes(counts), bytes(body)


def pascal_name(name: str) -> bytes:
    """레이어 이름 Pascal 문자열. 전체 길이가 4의 배수가 되도록 패딩."""
    raw = name.encode('ascii', 'replace')[:255]
    out = bytes([len(raw)]) + raw
    while len(out) % 4:
        out += b'\x00'
    return out


def luni_block(name: str) -> bytes:
    """포토샵이 읽는 유니코드 레이어 이름 블록. 한글 이름은 여기에 들어간다."""
    chars = name.encode('utf-16-be')
    payload = struct.pack('>I', len(name)) + chars
    while len(payload) % 4:
        payload += b'\x00'
    return b'8BIM' + b'luni' + struct.pack('>I', len(payload)) + payload


class Layer:
    def __init__(self, name, ascii_name, left, top, width, height,
                 color, alpha=255, opacity=255, visible=True):
        self.name = name
        self.ascii_name = ascii_name
        self.left, self.top = left, top
        self.width, self.height = width, height
        self.color = color
        self.alpha = alpha
        self.opacity = opacity
        self.visible = visible

    def planes(self):
        n = self.width * self.height
        r, g, b = self.color
        return [
            bytes([self.alpha]) * n,
            bytes([r]) * n,
            bytes([g]) * n,
            bytes([b]) * n,
        ]


def build_psd(path, width, height, layers, backdrop):
    # ── 파일 헤더 ─────────────────────────────────────────────────────────
    header = (b'8BPS' + struct.pack('>H', 1) + b'\x00' * 6 +
              struct.pack('>H', 3) +          # 채널 수 (RGB)
              struct.pack('>I', height) +
              struct.pack('>I', width) +
              struct.pack('>H', 8) +          # 채널당 비트 수
              struct.pack('>H', 3))           # 컬러 모드 = RGB

    color_mode = struct.pack('>I', 0)

    # 해상도 리소스 (72dpi) — 없으면 포토샵이 임의 값을 쓴다
    res = struct.pack('>I', 0x00480000) + struct.pack('>HH', 1, 2)
    res += struct.pack('>I', 0x00480000) + struct.pack('>HH', 1, 2)
    resource = b'8BIM' + struct.pack('>H', 0x03ED) + b'\x00\x00' + \
        struct.pack('>I', len(res)) + res
    image_resources = struct.pack('>I', len(resource)) + resource

    # ── 레이어 레코드 + 채널 데이터 ───────────────────────────────────────
    records = bytearray()
    channel_data = bytearray()

    for layer in layers:
        encoded = []
        for plane in layer.planes():
            counts, body = encode_channel(plane, layer.width, layer.height)
            encoded.append(struct.pack('>H', 1) + counts + body)

        records += struct.pack('>iiii', layer.top, layer.left,
                               layer.top + layer.height,
                               layer.left + layer.width)
        records += struct.pack('>H', 4)
        for cid, blob in zip((-1, 0, 1, 2), encoded):
            records += struct.pack('>h', cid) + struct.pack('>I', len(blob))
        records += b'8BIM' + b'norm'
        records += bytes([layer.opacity, 0, 0 if layer.visible else 2, 0])

        extra = struct.pack('>I', 0)          # 레이어 마스크 없음
        extra += struct.pack('>I', 0)         # 블렌딩 레인지 없음
        extra += pascal_name(layer.ascii_name)
        extra += luni_block(layer.name)
        records += struct.pack('>I', len(extra)) + extra

        for blob in encoded:
            channel_data += blob

    layer_info = struct.pack('>h', len(layers)) + bytes(records) + bytes(channel_data)
    if len(layer_info) % 2:
        layer_info += b'\x00'

    layer_and_mask = struct.pack('>I', len(layer_info)) + layer_info
    layer_and_mask += struct.pack('>I', 0)    # 전역 레이어 마스크 없음
    layer_and_mask = struct.pack('>I', len(layer_and_mask)) + layer_and_mask

    # ── 병합 이미지 (레이어를 지원하지 않는 뷰어가 보는 그림) ─────────────
    merged = struct.pack('>H', 1)
    counts_all = bytearray()
    body_all = bytearray()
    n = width * height
    for value in backdrop:
        counts, body = encode_channel(bytes([value]) * n, width, height)
        counts_all += counts
        body_all += body
    merged += bytes(counts_all) + bytes(body_all)

    with open(path, 'wb') as fh:
        fh.write(header + color_mode + image_resources + layer_and_mask + merged)

    return path


def swatches(y, box=54, gap=10, left=40):
    """팔레트 참고용 색 견본 줄."""
    palette = [
        ('브랜드_레드 #E12B20', 'brand-red', RED),
        ('딥레드 #A81811', 'deep-red', RED_DEEP),
        ('로고_옐로 #FFC72C', 'logo-yellow', YELLOW),
        ('크림 #FBF4EC', 'cream', CREAM),
        ('칩_골드 #D89A4E', 'chip-gold', GOLD),
        ('잉크 #1F1A18', 'ink', INK),
    ]
    out = []
    for i, (name, ascii_name, color) in enumerate(palette):
        out.append(Layer(name, ascii_name, left + i * (box + gap), y,
                         box, box, color))
    return out


def make_thumbnail():
    """대표이미지 1000×1000 템플릿."""
    w = h = 1000
    layers = [
        # 위에 있는 레이어가 먼저 오도록 배치
        Layer('가이드_세이프영역', 'guide-safe-area', 80, 80, 840, 840,
              GOLD, alpha=40, opacity=90),
        Layer('제품컷_자리 (누끼 PNG를 여기에)', 'product-shot-slot',
              180, 140, 640, 720, WHITE, alpha=0),
        *swatches(y=920),
        Layer('배경_크림', 'background-cream', 0, 0, w, h, CREAM),
    ]
    return build_psd('딱새우꾸어칩_대표이미지_1000.psd', w, h, layers, CREAM)


def make_detail():
    """상세페이지 860폭 섹션 작업용 캔버스."""
    w, h = 860, 2400
    layers = [
        Layer('가이드_좌우여백_48px', 'guide-margin', 48, 0, w - 96, h,
              GOLD, alpha=28, opacity=80, visible=False),
        Layer('섹션04_제품정보_자리', 'section-04-info', 0, 1800, w, 600, WHITE, alpha=0),
        Layer('섹션03_상세컷_자리', 'section-03-photo', 0, 1200, w, 600, WHITE, alpha=0),
        Layer('섹션02_스펙스트립', 'section-02-spec', 0, 900, w, 300, CREAM),
        Layer('섹션01_히어로_레드', 'section-01-hero', 0, 0, w, 900, RED),
        *swatches(y=2320, box=40, gap=8),
        Layer('배경_화이트', 'background-white', 0, 0, w, h, WHITE),
    ]
    return build_psd('딱새우꾸어칩_상세페이지_860.psd', w, h, layers, WHITE)


if __name__ == '__main__':
    for path in (make_thumbnail(), make_detail()):
        print('wrote', path)

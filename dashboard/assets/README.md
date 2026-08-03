# dashboard/assets — 마을 지도 이미지

이 폴더의 이미지는 **소스 자산**이다. CI 가 `dashboard/` 전체를 `_site/` 로 복사하므로
페이지에서는 `assets/<파일명>` 상대경로로 서빙된다(외부 요청 0 · CDN 금지 규약).

## 필요한 파일 2개

| 파일명 | 내용 |
|---|---|
| `village-day.webp` | 마을 지도 — 낮 (라이트 테마) |
| `village-night.webp` | 마을 지도 — 밤 (다크 테마) |

**두 장은 구도·건물 위치가 동일해야 한다.** 클릭 영역(`VILLAGE_ZONES` in `app.js`)이
비율 좌표로 두 장에 공통 적용되므로, 배치가 어긋나면 밤 테마에서 클릭이 빗나간다.

## 넣는 법

1. Gemini 로 생성한 PNG 를 받는다.
2. WEBP 로 변환·압축한다 (저장소가 아직 LFS 가 아니라 이력이 그대로 불어난다):
   ```bash
   # 예: 폭 1600px, 품질 82 — 지도 한 장이 대략 200~400KB 면 충분하다
   cwebp -q 82 -resize 1600 0 village-day.png  -o dashboard/assets/village-day.webp
   cwebp -q 82 -resize 1600 0 village-night.png -o dashboard/assets/village-night.webp
   ```
3. 커밋한다. 파일이 없으면 마을 화면은 안내 문구를 띄우고, 나머지 대시보드는 정상 동작한다.

## 넣지 말 것

- **실제 공식 마크**(우정사업본부 제비 CI·정부 태극 상징)를 이 공개 저장소에 커밋하지 말 것.
  로고 슬롯은 오리지널 엠블럼(`emblem.webp`, 선택)만 쓴다 — 접근제어 호스팅으로 옮기고
  기관 확인을 받은 뒤에 교체하는 것이 순서다(`docs/HANDOVER.md` §3.3).
- 이미지에 **글자를 굽지 말 것**. 라벨은 전부 코드가 얹는다(선명·수정·다국어·접근성).

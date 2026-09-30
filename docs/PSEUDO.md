# Pseudo 갱신 규칙

홈페이지 `#pseudo`는 리스크·자산배분·IT 인수인계용 구현 요약이다.
금융 계산의 정본은 Python/JavaScript 계산 함수이며 Pseudo는 검토하여 유지하는 문서다.
시장 JSON과 독립적으로 로드하며 계산 입력과 브라우저의 포트폴리오 저장값을 바꾸지 않는다.

| 화면 | 문서 | 주 계산 원본 |
|---|---|---|
| 리스크 | `dashboard/pseudo/risk.js` | `pipeline/risk.py` |
| 자산배분 | `dashboard/pseudo/alloc.js` | `pipeline/port.py`, `dashboard/app.js` |
| 환헤지 | `dashboard/pseudo/hedge.js` | `pipeline/hedge.py`, `dashboard/app.js` |

각 문서는 `id`, `title`, `updated`, `summary`, `inputs`, `outputs`, `sources`, `sections`를 갖는다.
각 절은 `id`, `title`, `formulas`(expression·legend), `code`, `note`로 구성한다.
수식과 기호·단위 설명은 코드 블록 밖에 두며, 유사코드는 입력→검사→계산→출력 순서로 짧게 쓴다.
`sources`에는 실제 경로와 함수명을 적는다. 원자료·수치 시계열·기관 포트폴리오를 기록하지 않는다.

## 모듈 변경 시

1. 수식, 입력 원천, 표본, 단위, 부호, 결측·이상치, 제약조건, 출력 의미 변경 여부를 확인한다.
2. 의미가 바뀌면 같은 PR에서 해당 문서의 수식·유사코드·짧은 주석·검토일을 갱신한다.
3. 연계 변경이면 상대 모듈도 대조한다. 예: 헤지비용 부호·환 공분산 변경은 자산배분도 확인한다.
4. `dashboard/index.html`의 수정한 문서 스크립트 `?v=`를 갱신한다.
5. `python -m pytest tests/test_pseudo.py`와 변경 계산에 해당하는 회귀검사를 실행한다.
6. 화면의 세 하위 탭, 복사, 좁은 화면을 확인한다. PR에 문서 변경 또는 변경 불필요 이유를 적는다.

색상·배치만 바뀌고 계산 의미가 같으면 문서를 억지로 바꾸지 않는다.
검사는 문서 구조·참조 함수·실제 탭 동작을 점검하며 수식의 의미적 일치를 자동 증명하지 않는다.
UI는 `dashboard/pseudo.js`, 스타일은 `dashboard/style.css`에서 관리한다.
외부 수식 렌더러나 CDN을 추가하지 않고 유니코드 수식을 선택·복사 가능한 텍스트로 표시한다.

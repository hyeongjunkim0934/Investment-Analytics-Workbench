# 초기 설정 가이드 (GitHub 웹에서만 진행)

이 문서의 모든 단계는 **브라우저(github.com)에서만** 진행합니다. 소요 시간은 약 5–10분입니다.

## 전체 구조

```
[비공개] hyeongjunkim0934/data          [공개] hyeongjunkim0934/Investment-Analytics-Workbench
┌──────────────────────────┐            ┌─────────────────────────────────────────┐
│ raw/*.xlsx  (원본 엑셀)   │            │ pipeline/   엑셀 → JSON 가공 스크립트     │
│                          │  dispatch  │ dashboard/  정적 대시보드 (HTML/JS)      │
│ 엑셀 푸시                 │ ─────────▶ │                                         │
│  → notify-workbench.yml  │            │ build-dashboard.yml                     │
└──────────────────────────┘            │  1. 비공개 data 저장소 체크아웃            │
                                        │  2. 엑셀 → 파생 JSON 가공                 │
                                        │  3. GitHub Pages에 대시보드 배포          │
                                        └─────────────────────────────────────────┘
```

- 원본 엑셀은 **비공개 data 저장소에만** 존재합니다. 공개 저장소에는 커밋되지 않고,
  빌드 때만 러너(runner) 안에서 읽힌 뒤 **가공·파생된 JSON만** Pages에 배포됩니다.
- 대시보드 주소: `https://hyeongjunkim0934.github.io/Investment-Analytics-Workbench/`

> ⚠️ **공개 범위 유의**: 대시보드 차트에 쓰이는 JSON은 Pages를 통해 누구나 접근할
> 수 있으며, 여기에는 파생 지표(스프레드 등)뿐 아니라 **패널에 선별된 원본 시리즈의
> 값 자체**(최근 구간 일별, 과거 구간 주별 축약)가 포함됩니다. 원본 엑셀 파일과
> 나머지 시리즈는 공개되지 않고, 카탈로그에는 값 없이 메타데이터만 실립니다.
> 어떤 시리즈를 공개할지는 `pipeline/process.py`의 패널 정의(`OVERVIEW_CARDS`,
> `CURVES`, `KR_CREDIT_3Y` 등)로 통제하세요 — 벤더 약관상 값 공개가 곤란한
> 시리즈는 패널에서 제외해야 합니다.

---

## 1단계 — Fine-grained PAT(토큰) 1개 만들기

두 저장소를 잇는 다리 역할의 토큰입니다.

1. GitHub 우측 상단 프로필 → **Settings**
2. 왼쪽 맨 아래 **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
3. **Generate new token** 클릭
4. 다음과 같이 입력:
   - **Token name**: `workbench-automation` (임의)
   - **Expiration**: 드롭다운에서 **Custom** 선택 후 약 1년 뒤 날짜 지정
     (7/30/60/90일 프리셋에는 1년이 없습니다. 만료 시 재발급 후 아래 시크릿 2개만 갱신하면 됩니다)
   - **Repository access**: **Only select repositories** 선택 후
     `data` 와 `Investment-Analytics-Workbench` 두 개 선택
   - **Permissions → Repository permissions**:
     - **Contents: Read and write** ← 이것 하나만 설정
5. **Generate token** → 생성된 `github_pat_...` 문자열을 복사해 둡니다
   (이 화면을 벗어나면 다시 볼 수 없습니다)

> 참고: 토큰 하나를 양쪽에 쓰는 대신 최소 권한으로 나누고 싶다면 두 개를 만드세요 —
> ① workbench에 `Contents: Read and write` 권한만 있는 토큰(1개 저장소만 선택) →
> `WORKBENCH_DISPATCH_TOKEN`용, ② data에 `Contents: Read-only` 권한만 있는 토큰 →
> `DATA_REPO_TOKEN`용.

## 2단계 — data 저장소에 시크릿 등록

1. `hyeongjunkim0934/data` 저장소 → **Settings** 탭
2. 왼쪽 **Secrets and variables** → **Actions**
3. **New repository secret** 클릭
   - **Name**: `WORKBENCH_DISPATCH_TOKEN`
   - **Secret**: 1단계에서 복사한 토큰 붙여넣기
4. **Add secret**

## 3단계 — Investment-Analytics-Workbench 저장소에 시크릿 등록

1. `hyeongjunkim0934/Investment-Analytics-Workbench` 저장소 → **Settings** 탭
2. 왼쪽 **Secrets and variables** → **Actions**
3. **New repository secret** 클릭
   - **Name**: `DATA_REPO_TOKEN`
   - **Secret**: 같은 토큰 붙여넣기
4. **Add secret**

## 4단계 — GitHub Pages 켜기 ⚠️ 5단계보다 먼저 해야 합니다

1. `Investment-Analytics-Workbench` 저장소 → **Settings** → 왼쪽 **Pages**
2. **Build and deployment → Source**: **GitHub Actions** 선택 (저장 버튼 없음, 선택 즉시 적용)

> 이 단계를 건너뛰고 빌드를 돌리면 **Setup Pages** 단계에서
> `Get Pages site failed … Not Found` 오류로 실패합니다.
> 그럴 땐 여기서 Source를 설정한 뒤 5단계로 재실행하면 됩니다(수정할 코드 없음).

## 5단계 — 첫 빌드 실행 & 확인

1. `Investment-Analytics-Workbench` 저장소 → **Actions** 탭
2. 왼쪽 **Build & deploy dashboard** 워크플로우 선택 → **Run workflow** → 초록 버튼 클릭
3. 1–2분 후 초록 체크가 뜨면 `https://hyeongjunkim0934.github.io/Investment-Analytics-Workbench/` 접속

## 6단계 — 자동화 동작 확인

두 저장소를 잇는 체인이 실제로 완주하는지 한 번 확인합니다.
경로가 둘 있고, 처음 확인할 때는 **A가 훨씬 빠릅니다**(엑셀을 다시 올릴 필요가 없습니다).

### A. 버튼으로 확인 (권장)

1. `data` 저장소 → **Actions** 탭 → 왼쪽 **Notify workbench** 선택
2. **Run workflow** → 브랜치는 **기본 브랜치**를 고르고 초록 버튼 클릭
3. 로그에 `dispatched data-updated (ref=… sha=…)`가 찍히면 발신 성공입니다
4. 잠시 후 `Investment-Analytics-Workbench` Actions 탭에서
   **Build & deploy dashboard**가 자동 실행되고, 완료되면 대시보드가 갱신됩니다

> 기본 브랜치가 아닌 브랜치를 고르면 job이 실패가 아니라 **skip**으로 끝납니다
> (실험용 브랜치의 데이터가 프로덕션에 나가는 것을 막는 가드입니다).
> 2단계의 시크릿을 빠뜨렸다면
> `WORKBENCH_DISPATCH_TOKEN 시크릿이 설정되지 않았습니다`로 명확히 실패합니다.

### B. 실제 엑셀 업로드로 확인

1. `data` 저장소 → `raw/` 폴더 → **Add file → Upload files**
2. 갱신된 엑셀 파일을 끌어다 놓고 **Commit changes**
3. `data` 저장소 Actions 탭에서 **Notify workbench** 실행 확인
4. 위 A의 4와 동일

평소 운영에서는 **엑셀을 업로드하기만 하면** B의 3–4가 자동으로 반복됩니다.
A는 데이터를 건드리지 않고 배선만 점검하고 싶을 때 쓰세요.

---

## 참고 — 브랜치 관련

세 저장소의 기본 브랜치는 **아직 기계 생성 세션명**입니다
(`Investment-Analytics-Workbench`·`Data` = `claude/data-repo-dashboard-automation-cj8y59`,
`AIs` = `claude/five-independent-agents-s9i539`). `main` 으로 바꾸는 것은 **아직 하지 않았고**,
아래가 그 절차입니다. GitHub 웹에서만 할 수 있는 작업이라 사람이 직접 해야 합니다.

1. 세 저장소 각각 **Settings → General → Default branch → ✏️ → `main` → Rename**.
   GitHub이 열린 PR의 base와 브랜치 리다이렉트는 자동으로 옮겨 줍니다.
2. **여기서 빠뜨리기 쉬운 한 가지** — workbench 저장소 → **Settings → Environments →
   github-pages → Deployment branches**에 `main`을 추가하세요. 이 목록만은 rename을 따라
   자동 갱신되지 **않습니다**. 빠뜨리면 build는 성공하는데 deploy만
   `Branch "main" is not allowed to deploy to github-pages …` 로 실패해, Actions 목록에서는
   빨간불이 늦게 눈에 띕니다.
3. 그 **다음에** `build-dashboard.yml`의 `push:` 트리거에서 세션명 한 줄을 지워
   `branches: [main, master]` 로 정리하는 커밋을 올리세요. 순서가 반대면(rename 전에 먼저
   지우면) 그 사이 기본 브랜치 push가 아무 워크플로도 트리거하지 않는 잠복 구간이 생깁니다.
   지금은 세 이름이 모두 들어 있어 rename 전후 어느 쪽에서도 트리거가 끊기지 않습니다.
4. 마지막으로 **Actions → Build & deploy dashboard → Run workflow**를 한 번 돌려
   test → build(배포 게이트) → deploy가 끝까지 초록인지 확인하세요.
5. 열려 있는 dependabot PR들의 base가 `main`으로 옮겨졌는지 눈으로 확인하세요.

`Data`의 `notify-workbench.yml`과 `AIs`에는 브랜치명이 하드코딩되어 있지 않아
(발신측은 `github.event.repository.default_branch`와 비교) 고칠 파일이 없습니다.

- data 저장소에서 엑셀을 갱신할 때는 **기본 브랜치에 직접 커밋**하세요.
  "Create a new branch … and start a pull request"를 선택하면 병합 전까지
  대시보드가 갱신되지 않습니다(기본 브랜치 푸시만 트리거됨).

## 파일 규칙 (data 저장소)

| 파일명 패턴 | 해석 방식 |
|---|---|
| `data_bb*.xlsx` | 블룸버그 와이드 포맷 (카테고리/Notation 헤더 + 일별 시계열) |
| `data_info*.xlsx` | 인포맥스 와이드 포맷 (Category/Ticker/Notation 헤더 + 일별 시계열) |
| 그 외 `*.xlsx` (예: `ACWI08.xlsx`, `ACWI17.xlsx`) | 지수 익스포트 (A1=지수명, `일자/종가` 표). **같은 지수명의 파일 여러 개는 자동 병합**되며, 날짜가 겹치면 더 최신 데이터가 우선합니다 |

- 폴더 위치는 자유입니다(저장소 전체를 재귀 탐색). `raw/` 폴더 사용을 권장합니다.
- 같은 이름의 파일을 다시 업로드하면 덮어쓰기 → 자동 재빌드됩니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 엑셀을 올렸는데 대시보드가 안 바뀜 | ① data 저장소 Actions에서 Notify workbench가 성공했는지 ② 실패 로그에 토큰 오류가 있으면 `WORKBENCH_DISPATCH_TOKEN` 재확인 (만료 여부 포함) |
| Build & deploy dashboard가 체크아웃 단계에서 실패 | `DATA_REPO_TOKEN` 시크릿 누락/만료, 또는 토큰의 Repository access에 `data`가 포함 안 됨 |
| **Setup Pages** 단계에서 `Get Pages site failed … Not Found` | 4단계(Pages Source = GitHub Actions)를 아직 안 한 것 — 설정 후 워크플로우 재실행 |
| 대시보드 접속 시 404 | 4단계 Pages 설정(Source = GitHub Actions)이 되어 있는지, 첫 배포가 성공했는지 |
| deploy 단계에서 `Branch "…" is not allowed to deploy to github-pages` 오류 | 기본 브랜치 이름을 바꾼 뒤 발생 — Settings → Environments → github-pages → Deployment branches에 새 기본 브랜치 추가 |
| 빌드는 성공했는데 일부 차트가 "데이터 없음" | 엑셀에서 해당 시리즈(Notation)가 빠졌거나 이름이 바뀐 경우 — Actions 로그와 대시보드 하단 경고 수, 브라우저 콘솔의 `pipeline warnings` 확인 |
| 토큰 만료(1년) | 1단계로 새 토큰 발급 → 2·3단계 시크릿 값만 교체 |
| build가 **Deploy gate — JSON 계약 검사**에서 실패 | 의도된 차단입니다. 로그의 `::error::배포 게이트:` 줄이 원인(JSON 누락/경고 초과/시리즈 부족)을 말해 줍니다. JSON 누락이면 그 위 **Build dashboard data** 로그에 risk/hedge traceback이 있습니다 |
| build가 **Verify data files are real workbooks**에서 실패 | 체크아웃된 xlsx가 ZIP(`PK`)이 아닙니다 — 업로드가 잘렸거나, 엑셀이 아닌 파일이 `.xlsx` 이름으로 올라갔거나, (data가 LFS로 전환된 뒤라면) 포인터 상태입니다. `DATA_REPO_TOKEN`이 유효한지, 체크아웃에 `lfs: true`가 있는지 확인 |
| **test** 잡이 실패 | 파이프라인 계약이 깨졌습니다. 로컬에서 `python -m pytest`로 재현됩니다(비공개 데이터 불필요) |

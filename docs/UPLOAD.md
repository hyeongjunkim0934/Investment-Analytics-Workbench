# Homepage Upload

`Pseudo → Upload`에서 `data_bb*.xlsx`와 `data_info*.xlsx`를 함께 선택해 기존
비공개 `hyeongjunkim0934/Data` 원본을 교체한다. 파일별 상한은 25 MiB다.
두 파일을 하나의 커밋으로 반영하므로 한 파일만 바뀐 중간 상태로 빌드하지 않는다.

## 사용 순서

1. GitHub Fine-grained PAT의 저장소 범위를 `hyeongjunkim0934/Data`로 제한하고
   **Contents: Read and write** 권한을 부여한다.
2. 홈페이지 Upload에서 토큰을 입력하고 **연결 확인**을 누른다.
   토큰을 채팅·저장소·설정 파일에 입력할 필요는 없다.
3. 두 엑셀을 선택한다. 종류별 기존 원본이 하나면 교체 경로를 자동 선택한다.
   여러 개면 교체할 경로를 명시적으로 선택한다. 파일명이 달라져도 새 파일을
   추가하지 않으므로 이전 파일과 중복 병합되지 않는다.
4. **두 파일 업로드 · 전체 업데이트**를 누른다. 원본 저장 완료와 홈페이지
   반영 완료는 별개다. 성공 후 토큰 연결을 해제하고 입력칸을 비운다.
5. **반영 상태 확인**으로 배포를 확인한 뒤 **전체 화면 새로고침**을 누른다.
   각 JSON에 같은 새 캐시 키를 붙이고 `cache: no-store`로 읽는다.

기존 `WORKBENCH_DISPATCH_TOKEN`, `DATA_REPO_TOKEN`, Pages 설정이 필요하다.
초기 설정은 [SETUP.md](SETUP.md)를 따른다. 홈페이지 토큰은 Data 쓰기만 필요하며
IAW 저장소에 별도 쓰기 권한을 줄 필요가 없다. `checkNotification` API를 별도로
사용할 때만 Data Actions 읽기 권한도 필요하다. 현재 UI는 이 API 대신 공개된
배포 메타와 Actions 웹 링크를 사용한다.

## 기존 데이터 경로와 병행

두 경로는 같은 Data 입력 및 빌드 경로를 사용한다.

- 기존 자동 갱신 → Data 원본 변경 → Notify workbench
- 홈페이지 Upload → 같은 Data 원본 변경 → Notify workbench

그 뒤에는 기존 Python 계산 → 15개 JSON 계약 검사 → GitHub Pages 배포를 그대로
실행한다. BM·ACWI·리포트 파일, 수기 CMA/포트폴리오 입력, 외부에서 만들어 오는
환율모형B 사전계산 파일은 유지한다. 이 업로드가 외부 모형을 재학습하지는 않는다.
현재 두 저장소에는 Google Drive 직접 연동 코드가 없으므로 외부 Drive 동기화
서비스의 연결·주기·권한은 이 변경의 검증 범위에 포함되지 않는다.

연결 시와 쓰기 직전에 Data의 비공개 상태·실제 기본 브랜치·HEAD를 확인한다.
기본 브랜치를 하드코딩하지 않으며, 기존 동기화가 먼저 원본을 바꾸면 업로드를
중단하고 재연결을 요구한다. 최종 ref 갱신도 `force:false`로 수행한다.
Data 저장소의 다른 파일과 IAW 자동화 트리거는 변경하지 않는다.

## 저장·배포 판정과 실패 처리

- `git/blobs` 2개 → 기존 tree 위에 두 경로만 교체 → 부모 HEAD를 유지한 커밋 →
  단 한 번의 ref 갱신. ref가 반영되기 전 실패하면 기존 원본은 유지된다.
- 두 파일이 모두 기존 내용과 같으면 새 커밋·배포를 실행하지 않는다.
- 최종 응답이 유실되면 알려진 커밋의 반영 여부를 조회한다. 확인 불가 시
  **저장 결과 미확인**으로 표시하고 후보 커밋 링크를 남긴다. 쓰기를 자동 재시도하지 않는다.
- 실제 빌드에서 체크아웃한 Data HEAD를 `process.py --source-sha`로 전달하여
  `meta.json.data_source_sha`에 기록한다. 기존 dispatch의 ref→최신 데이터 의미를 유지한다.
- 해당 업로드 SHA가 배포 메타와 정확히 일치할 때만 **홈페이지 반영 완료**로 표시한다.
  후속 자동 갱신으로 SHA가 달라지면 미확인 상태이며, timestamp나 ancestor 관계만으로
  업로드 값의 반영을 단정하지 않는다. 자동 무한 대기 없이 수동 확인·Actions 링크를 제공한다.
- 배포 게이트 실패 시 기존 홈페이지를 유지한다. 이 경우 이미 저장한 원본은 Data에
  남으므로 파일을 수정해 다시 업로드해야 한다. 기존 파일로 되돌리는 작업도 Data의
  정상 갱신 절차를 따른다.

## 파일·인증 검증

클라이언트는 확장자·종류·크기, ZIP 중앙/로컬 디렉터리와 필수 XLSX 구성,
암호화/매크로·경로 이상·512 MiB 초과 압축 해제 크기를 검사한다. 파일명만 바꾼
임의 ZIP은 거부한다. 시계열·열 형식의 최종 검증은 기존 Python 파서와 배포 게이트다.
브라우저 사전검사가 엑셀 내용의 경제적 정확성을 보장하지 않는다.

토큰과 파일은 localStorage/sessionStorage·URL·로그에 저장하지 않는다. 인증 요청은
고정된 GitHub API의 Data 저장소로만 전송하며 리다이렉트를 거부한다. API 응답 본문과
임의 네트워크 오류를 화면에 그대로 출력하지 않는다. 탭/테마 변경 중에는 선택한
파일과 진행 상태를 유지하고, 페이지 이탈·뒤로 가기 복귀 시 인증 상태를 정리한다.

## 검증

`tests/test_data_upload_client.py`: 독립 mock API에서 두 파일의 원자적 반영,
기존 파일 보존, 파일 검증 실패 시 쓰기 없음, 동시 갱신/브랜치 변경,
최종 응답 유실·재조회, 인증 오류 비노출, 동일 원본 처리.

`tests/test_data_upload_ui.py`: 실제 JS 렌더러와 라우팅의 연결·실패·중복 클릭,
테마/탭 전환·페이지 복귀, 토큰 제거, 저장과 배포의 구분, 정확한 SHA 확인,
현재 금융 데이터와 사용자 설정 보존.

`tests/test_contract.py`: 합성 XLSX의 전체 Python 빌드·JSON 계약과 source SHA 기록.
실제 운영 토큰·원본 업로드·외부 Drive 동기화의 end-to-end 검증은 실행하지 않는다.
이번 작업의 브라우저 시각검증은 공유 preview 슬롯 사용 중으로 미완료다.

GitHub REST 근거: [Git references](https://docs.github.com/en/rest/git/refs),
[CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests).

# context-auto-handoff

**[English](README.md)** | 한국어

컨텍스트 압축이나 세션 종료 직전, 다음 세션이 현재 맥락을 그대로 이어받도록 토큰 효율적인 핸드오프 문서를 자동으로 써 두는 Claude Code 플러그인.

![npm version](https://img.shields.io/npm/v/claude-context-auto-handoff)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## 필수 요구사항

- **Node.js 18+** — `node` 명령어가 `PATH`에 있어야 함
- **Claude Code** 또는 **Codex** — 플러그인 및 훅 실행에 Claude Code CLI 또는 Codex CLI 필요

---

## 개요

Claude의 컨텍스트 창이 가득 차면 대화가 자동으로 압축됩니다. 이때 방금 내린 설계 결정, 해결 중이던 버그, 다음 할 일이 흐릿해집니다. 이 플러그인은 `PreCompact`와 `Stop` 이벤트를 감지해 압축 전에 AI가 직접 핸드오프 문서를 씁니다. 다음 세션은 그 파일 하나로 즉시 이어집니다.

핸드오프 내용은 **텔레그래피즘**(관사·군더더기·코드 스니펫 없음)으로 작성해 토큰은 아끼면서도 다음 세션에 필요한 결정 맥락은 그대로 남깁니다.

초안 작성(1회 저장당 3-6k 토큰 규모)은 Haiku 서브에이전트가 맡아 `generate_handoff_manifest` 호출까지 직접 수행합니다 — 초안이 메인 세션 모델 컨텍스트를 거치지 않습니다.

핸드오프 작성 시 주요 내용(`implicitRules`, `keyDecisions`)은 `CLAUDE.md`에도 함께 갱신되어, 재개(resume) 없이도 매 세션 자동으로 로드됩니다.

---

## 구성 요소

### 도구 (Tools)

- **`generate_handoff_manifest`** — 현재 프로젝트의 `.claude/handoff.md`에 구조화된 핸드오프 문서를 저장합니다. `.claude/handoffs/{YYYY-MM-DD}/handoff-{timestamp}.md`에도 아카이브됩니다 (최근 50개 파일만 유지, 자동 정리). 동시에 `.claude/handoffs/index.md`에 한 줄 요약(날짜, 키워드, 헤드라인, 경로)을 upsert해 — 아카이브 파일을 전부 열지 않고도 grep 한 번으로 과거 세션을 찾을 수 있는 경량 인덱스를 유지합니다. 한 세션 안에서 여러 번 저장돼도(예: 긴 세션에서 `PreCompact`와 `Stop`이 둘 다 발동) 새 파일을 쌓지 않고 그 세션의 아카이브 파일·인덱스 줄을 그대로 갱신합니다 — MCP 서버 프로세스 하나당 세션ID 하나를 부여해 frontmatter `session:` 필드에 기록합니다.

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| `nextSteps` | `string[]` | ✅ | 다음 세션에서 즉시 이어받을 할 일 목록 |
| `summary` | `string` | ✗ | 간결한 세션 요약 (텔레그래피즘) — 다른 필드로 충분하면 생략 |
| `taskDescription` | `string` | ✗ | 상위 목표 + 핵심 의도 (왜 중요한가) |
| `currentStatus` | `string` | ✗ | 완료된 것 vs 남은 것 — 무엇이 아닌 왜를 명시 |
| `keyDecisions` | `string[]` | ✗ | 아키텍처 결정과 이유. 형식: `"Decision: X — Reason: Y"` |
| `failedApproaches` | `string[]` | ✗ | 이미 실패한 시도. 형식: `"Approach: X → Result: Y → Lesson: Z"` |
| `modifiedFiles` | `string[]` | ✗ | 변경 파일과 델타 메모. 형식: `"경로/파일: 무엇을 변경"` — 코드 금지 |
| `implicitRules` | `string[]` | ✗ | 기술 스택, 네이밍 컨벤션, 환경변수 — 코드에서 유추 불가한 규칙 |
| `blockers` | `string` | ✗ | 미해결 에러 또는 막혀 있는 문제 |
| `workingDirectory` | `string` | ✗ | handoff.md를 쓸 프로젝트 루트 절대 경로 — Windows에서 `process.cwd()`가 System32를 가리킬 때 필요 |

### 스킬 (Skills)

| 명령어 | 동작 |
|--------|------|
| `/handoff-save` | Haiku 서브에이전트에 위임 — 세션 컨텍스트 초안 작성 + `generate_handoff_manifest` 호출까지 직접 수행 (3-6k 토큰 초안이 비싼 메인 모델을 거치지 않음) |
| `/handoff-resume` | `.claude/handoff.md` 읽어 새 세션에서 컨텍스트 복원 |
| `/handoff-search` | `.claude/handoffs/index.md`를 grep해 주제와 일치하는 과거 세션 검색 — DB·임베딩 없음 |

### 훅 (Hooks)

Claude Code 훅은 기본 내장. Codex 훅은 `templates/.codex`를 프로젝트 루트에 복사해야 활성화됩니다 ([Codex 설치](#codex) 참조).

| 이벤트 | 동작 |
|--------|------|
| `PreCompact` | 컨텍스트 압축 직전 `handoff-save` 스킬(Haiku 서브에이전트) 호출 지시 |
| `Stop` | 핸드오프 파일이 오래됐거나 없으면 경고 |
| `SessionStart` | 핸드오프 존재 시 짧은 힌트(경과 시간, 주제)만 노출 — 전체 내용은 키워드 매칭이나 `/handoff-resume`으로 로드 |
| `UserPromptSubmit` | 프롬프트가 직전 핸드오프의 키워드와 일치하면 전체 컨텍스트 자동 주입 |

---

## 빠른 시작

**Linux / macOS**
```bash
curl -fsSL https://raw.githubusercontent.com/Ethualo/claude-context-auto-handoff/main/scripts/setup.sh | bash
# Codex도 함께 설정 (훅 + handoff-drafter 서브에이전트 + AGENTS.md):
curl -fsSL https://raw.githubusercontent.com/Ethualo/claude-context-auto-handoff/main/scripts/setup.sh | bash -s -- --codex
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/Ethualo/claude-context-auto-handoff/main/scripts/setup.ps1 -OutFile setup.ps1
.\setup.ps1          # Claude Code만
.\setup.ps1 -Codex   # Codex도 함께 설정 (훅 + handoff-drafter 서브에이전트 + AGENTS.md)
```

**npm (크로스플랫폼)**
```bash
npm install -g claude-context-auto-handoff
claude-context-handoff-setup           # Claude Code만
claude-context-handoff-setup --codex   # Codex도 함께 설정
```

---

## 설치

### Claude Code 플러그인으로 설치

```bash
claude plugin install claude-context-auto-handoff
```

### npm 패키지로 설치

```bash
npm install -g claude-context-auto-handoff
claude-context-handoff-setup  # hooks.json 자동 배치, --codex 붙이면 Codex도 함께 설정
```

### MCP 수동 설정 (Claude Code)

Claude Code `settings.json`에 추가:

```json
{
  "mcpServers": {
    "context-handoff-manager": {
      "command": "node",
      "args": ["/path/to/build/index.js"]
    }
  }
}
```

### Codex

`~/.codex/config.toml`에 추가 (전역 MCP 설정):

```toml
[mcp_servers.context-handoff]
command = "node"
args = ["/path/to/build/index.js"]
```

그런 다음 훅 템플릿과 지시문을 프로젝트 루트에 복사:

```bash
cp -r /path/to/claude-context-auto-handoff/templates/.codex ./.codex
cp /path/to/claude-context-auto-handoff/templates/AGENTS.md ./AGENTS.md
```

Claude Code와 동일한 `SessionStart`, `PreCompact`, `Stop` 훅이 켜지고 핸드오프 초안 작성+저장을 메인 스레드 밖에서 처리하는 `handoff-drafter` 서브에이전트(`.codex/agents/handoff-drafter.toml`)도 함께 활성화됩니다.

---

## 사용법

### Claude Code

네 훅 모두 자동으로 돕니다 — `SessionStart`는 핸드오프 있으면 짧은 힌트 노출, `UserPromptSubmit`은 프롬프트가 저장된 키워드와 일치하면 전체 컨텍스트 자동 로드, `PreCompact`는 압축 전 저장, `Stop`은 핸드오프가 오래됐을 때 경고. 생성된 문서는 `.claude/handoff.md`에 저장됩니다.

**수동 체크포인트:**
```
/handoff-save
```

**수동 복원 (키워드 매칭이 안 됐을 경우):**
```
/handoff-resume
```

**과거 세션 검색:**
```
/handoff-search <주제>
```

### Codex

같은 세 훅이 `.codex/hooks.json`으로 자동 실행됩니다. 슬래시 명령어 없음 — 훅이 모두 처리.

| 이벤트 | 동작 |
|--------|------|
| `SessionStart` | `.claude/handoff.md`를 읽어 컨텍스트로 주입 |
| `PreCompact` | 압축 전 `handoff-drafter` 서브에이전트에 위임 지시 |
| `Stop` | 핸드오프가 오래됐거나 없으면 경고 |

### 출력 형식

```markdown
# Session Handoff Snapshot
> **Generated:** 2026. 6. 22. 오후 3:30:00

## 🎯 High-Level Objective
* **Goal:** Supabase + Notion 주식 데이터 실시간 동기화 Next.js 15 앱 구축
* **Core Intent:** Zustand 스토어로 클라이언트 재요청 최소화 — 비용 절감

## 📌 Current State & Next Steps
* **Status:** Task 3 (Zustand 스토어) 완료
* **Blocker:** Notion API rate limit (3 req/s) — 버퍼 레이어 필요
* **Next Action:** Supabase Edge Functions 디바운스 큐 구현

## 🛠️ Modified Files Delta
* src/store/stockStore.ts: Zustand 스토어 뼈대 + syncStatus 상태 정의
* src/app/api/notion/sync/route.ts: POST 핸들러 작성 완료, Supabase 미연결

## 🚫 Failed Approaches (DO NOT RETRY)
* Approach: Server Actions에서 Notion API 직접 호출 → Result: 리렌더 시 rate limit 즉시 터짐 → Lesson: 큐 미들웨어 필수
* Approach: useEffect 주기 폴링 → Result: Supabase 읽기 사용량 급증 → Lesson: 폐기

## 🔑 Crucial Context & Implicit Rules
* Stack: Next.js 15 (App Router), Supabase v2, Zustand v5
* Naming: API 엔드포인트 항상 route.ts, 스토어 PascalCase
* Env: NEXT_PUBLIC_SUPABASE_ANON_KEY 사용 중

---
*세션 시작 시 짧은 힌트만 노출됩니다. 전체 컨텍스트는 다음 프롬프트가 위 키워드와 일치할 때, 또는 수동 `/handoff-resume`으로 로드됩니다.*
```

---

## 라이선스

MIT

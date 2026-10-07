<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- graft:start -->
## Graft — Grafo de Código Estático

> **Diretiva de Especificação, Governança e Grafo de Código:**
> 1. Antes de construir ou editar código, consulte sempre as especificações OpenSpec (`openspec/`) e a documentação DOX (`AGENTS.md`) locais deste projeto como fontes autoritativas de requisitos.
> 2. O Graft indexa estritamente código-fonte (AST/símbolos), e não arquivos Markdown.
> 3. Para consultas ao grafo deste projeto, utilize exclusivamente o utilitário do harness com raiz obrigatória explícita do checkout atual sob trabalho e telemetria desativada:
>    - Quem chama um símbolo: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh query callers <target-absoluto> <simbolo> [--depth N]
>    - Assinaturas de um arquivo: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh query skeleton <target-absoluto> <arquivo>
>    - Busca semântica estrutural: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh query ask <target-absoluto> "<pergunta>" [--source]
>    - Mapa de orientação do repositório: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh query map <target-absoluto>
>    - Reconciliação / Verificação: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh check <target-absoluto> [--json]
>    - Rebuild do cache: /Users/guilhermevarela/orchestrator/scripts/project-graft.sh ensure <target-absoluto>
>    (Onde `<target-absoluto>` deve ser substituído pela raiz absoluta do checkout atual sob trabalho, obtida do brief ou contexto de execução).
<!-- graft:end -->

# Bops — local fork

## Purpose

Clone de `github.com/nickvasilescu/bops` mantido localmente pelo dono para self-hosting num Mac. App Electron (`desktop/`) que carrega o servidor Next.js (`app/`, `lib/server/`) na porta 3210. Visão geral, layout e serviços externos: [README.md](README.md). Convenções de escrita do código: [CONTRIBUTING.md](CONTRIBUTING.md) (seção "How the code is written").

## Ownership

- `origin` é o upstream; não há permissão de push. Customizações locais ficam commitadas no `main` local e integrações do upstream entram por merge normal.
- Este repo não usa OpenSpec. Escopo e provas de mudanças delegadas ficam no ticket do harness; o "como" fica neste DOX.

## Local Contracts

- Self-hosting: `BOPS_SELF_HOSTED=1` em `.env.local`. Nesse modo o app não pede login Orgo (`authStatus` em `lib/server/orgo-sign-in.ts`); serviços são chamados diretamente com as chaves de `.env.local`.
- Estado do app: `.data/state.json` relativo ao `cwd` do servidor (`lib/server/persist.ts`). Perfis Chrome e workspace dos bots: `~/.bops/` (`lib/server/local.ts`). Segredos: Keychain, item "Bops Vault" (`lib/server/keychain.ts`).
- Modelos: por runtime (`lib/server/runtime/`, [AGENTS.md](lib/server/runtime/AGENTS.md)). `BOPS_RUNTIME` / `BOPS_<TEXT|TASK|VOICE>_RUNTIME`, ids `openai` (default, upstream) e `codex` (assinatura ChatGPT via login do Codex; `~/.codex/auth.json` só lido, nunca escrito). Chamadores de texto usam só `generateText` de `lib/server/runtime/text/index`. A instância do dono usa `BOPS_RUNTIME=codex`.
- Nunca colocar chaves, telefones, e-mails ou dados pessoais em código, prompts, exemplos ou testes.

## Work Guidance

- Next.js 16 tem breaking changes: consultar `node_modules/next/dist/docs/` antes de usar uma API do Next.
- Testes do servidor são scripts Node com dependências falsas em localhost e estado em pasta temporária (padrão: `scripts/test-phone-voice.mjs`). Rodar com `node --conditions=react-server scripts/<teste>.mjs`; nada pode chegar à rede real.

## Verification

Gates estáticos (os mesmos do CI em `.github/workflows/ci.yml`):

```bash
npx next typegen
npx tsc --noEmit -p .
npm run lint            # 0 errors; warnings preexistentes em site/
node --conditions=react-server scripts/test-phone-voice.mjs
node --conditions=react-server scripts/test-runtime-text.mjs
node --conditions=react-server scripts/test-runtime-tasks.mjs
```

Test Coverage Matrix:

| Camada / path | Tier | Como rodar |
|---|---|---|
| `lib/server/phone-voice.ts`, `app/api/phone/agentphone` | integração com OpenAI/backend Codex/AgentPhone falsos (runtimes openai e codex) | `node --conditions=react-server scripts/test-phone-voice.mjs` |
| `lib/server/runtime/text/**`, `lib/server/runtime/codex/**`, chamadores de texto (`chat.ts`, `memory.ts`, `watches.ts`, `sessions.ts` `suggestReplies`), `lib/server/codex.ts` (app-server sobe na config do usuário) | integração com backend Codex/OpenAI falsos, `CODEX_HOME` temporário; Codex CLI real sem rede | `node --conditions=react-server scripts/test-runtime-text.mjs` |
| `lib/server/runtime/tasks/**`, `sessions.ts` (tarefas) | integração com singleton app-server e Agents API falsos, workspace/estado temporários; inclui ciclo da sessão e chat | `node --conditions=react-server scripts/test-runtime-tasks.mjs` |
| `lib/server/**` demais | typecheck + lint | `npx tsc --noEmit -p .` · `npm run lint` |
| fluxo do app | e2e real | roteiro abaixo |

Roteiro de verificação real (lido por `to-execute`):

1. **Isolamento:** rodar a partir de um checkout/worktree próprio (o `.data/` dele é o sandbox) numa porta livre diferente de 3210, que é a instância de uso do dono. `.env.local` próprio no checkout de teste, copiado do principal. Registrar `shasum -a 256` de `<checkout principal>/.data/state.json` antes e depois: deve ficar inalterado. `~/.bops/` e o Keychain são compartilhados; usar só bots/dados criados pelo teste. Para tarefas de navegador, definir `BOPS_CDP_BASE_PORT` num intervalo livre (default 9300) evita reutilizar o Chrome da instância do dono. `git check-ignore -q .tmp/` precisa passar.
2. **Launch:** `npx next dev --port <porta>` no checkout de teste. Readiness: `curl -s http://127.0.0.1:<porta>/api/health` devolve `{"bops":true}`.
3. **Doctor (read-only):** `curl -s http://127.0.0.1:<porta>/api/auth/status` devolve `"needsSignIn":false` em self-hosting; `codex login status` informa o login usado pelo runtime Codex; `/api/state` → `mac.next` não é `codex` (app-server subiu).
4. **Ação:** pelo navegador real em `http://localhost:<porta>` (não `127.0.0.1`: o `next dev` bloqueia esse origin para os recursos de dev e a página fica em "Loading Bops…"). Exemplo: mandar mensagem ao Boppy pelo campo "Text Boppy" e esperar a resposta na conversa.
5. **Observável e efeitos:** a resposta aparece na UI **e** persiste em `<checkout de teste>/.data/state.json` (`messages` do chat).
6. **Evidência:** `.tmp/verify/<ticket>/<item>/evidence.md`, com comando, saída literal e digest de cada anexo.
7. **Cleanup:** encerrar só os PIDs iniciados pelo teste; nunca apagar evidência.

### Build

```json
{"command":{"argv":["npx","next","build"],"cwd":"."}}
```

## DOX Framework

- Este repo usa DOX: AGENTS.md hierárquico, por domínio/pasta durável quando necessário. Cada AGENTS.md é contrato vinculante da sua subárvore.
- DOX é o eixo ESPAÇO (onde o código mora, como editar aqui). Este repo não tem OpenSpec; mudanças de comportamento são escopadas no ticket do harness.

### Read Before Editing
1. Ler este AGENTS.md (raiz) + identificar cada path que vai tocar.
2. Caminhar da raiz até cada alvo, lendo todo AGENTS.md no caminho (Child DOX Index aponta o próximo).
3. Doc mais próximo controla detalhe local; pais controlam regra repo-wide.
4. Re-ler a cadeia DOX na sessão atual antes de editar. Edição mínima no lugar certo.

### Update After Editing (DOX pass — obrigatório no closeout)
- Toda mudança significativa: atualizar o AGENTS.md dono mais próximo + pais afetados + Child DOX Index. Remover texto stale na hora.

### Child Doc Shape
Criar AGENTS.md filho quando a pasta vira boundary durável com regra própria. Seções: **Purpose** · **Ownership** · **Local Contracts** · **Work Guidance** · **Verification** · **Child DOX Index**.

## Child DOX Index

- [lib/server/runtime/AGENTS.md](lib/server/runtime/AGENTS.md) — runtimes de modelo (seleção, auth/cliente Codex, capacidades text/tasks; como adicionar um runtime).

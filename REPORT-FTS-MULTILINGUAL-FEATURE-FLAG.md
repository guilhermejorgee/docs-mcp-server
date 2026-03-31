# Relatório de Viabilidade: Feature Flag para FTS Multilingual Stemming

**Projeto:** `arabold/docs-mcp-server`  
**Branch:** `feat/postgres`  
**Data:** 30/03/2026  
**Feature analisada:** `fts-multilingual-stemming`  
**Escopo:** Avaliar viabilidade de criar um feature flag em nível de código para habilitar/desabilitar o sistema multilíngue sem comprometer o GIN index e o armazenamento.

---

## Sumário Executivo

A feature `fts-multilingual-stemming` **já está completamente implementada** e, estruturalmente, **já possui um mecanismo de feature flag natural** via a configuração `ftsLanguages`. O comportamento padrão (`ftsLanguages: ["simple"]`) é **idêntico ao pré-feature** — nenhuma mudança de comportamento acontece sem opt-in explícito. 

Entretanto, há lacunas importantes: o flag está implícito na config de busca (sem visibilidade de código), não existe mecanismo de reindexação incremental, e toggling mid-deployment pode gerar **inconsistência de índice**. A criação de um feature flag formal é **viável, de baixo esforço e recomendada**.

**Veredicto:** ✅ **Alta viabilidade** — implementação estimada em 2 tarefas incrementais de baixo risco.

---

## 1. Estado Atual da Feature Implementada

### 1.1 O que foi entregue

| Componente | Arquivo | Status |
|-----------|---------|--------|
| Migration: FTS configs `pt_unaccent` e `en_unaccent` | `db/migrations-pg/014-add-fts-stemming-configs.sql` | ✅ Implementado |
| Helper `buildFtsTsvectorSql(langs)` | `src/store/PostgresDocumentStore.ts:126` | ✅ Implementado |
| Helper `buildFtsTsquerySql(langs)` | `src/store/PostgresDocumentStore.ts:146` | ✅ Implementado |
| Wiring em `addDocuments()` | `src/store/PostgresDocumentStore.ts:678` | ✅ Implementado |
| Wiring em `findByContent()` | `src/store/PostgresDocumentStore.ts:878` | ✅ Implementado |
| Validação anti-SQL-injection no config | `src/utils/config.ts:283` | ✅ Implementado |
| Testes de integração de stemming | `src/store/PostgresDocumentStore.test.ts:413` | ✅ Implementado |

### 1.2 Como funciona a feature

A feature adiciona vetores FTS com stemming por idioma ao `fts_vector` existente. Com `ftsLanguages: ["english", "portuguese"]`:

**Indexação (INSERT):**
```sql
-- Layer 1: multilingual (sempre presente - match exato + unaccent)
setweight(to_tsvector('multilingual', coalesce(title, '')), 'A') ||
setweight(to_tsvector('multilingual', coalesce(path, '')), 'B') ||
setweight(to_tsvector('multilingual', coalesce(content, '')), 'C') ||
-- Layer 2: stemming adicional (only when feature is ON)
to_tsvector('en_unaccent', coalesce(content, '')) ||
to_tsvector('pt_unaccent', coalesce(content, ''))
```

**Busca (WHERE + ts_rank_cd):**
```sql
-- Feature OFF: somente multilingual
plainto_tsquery('multilingual', $1)

-- Feature ON: multilingual OR stemmed
plainto_tsquery('multilingual', $1)
|| plainto_tsquery('en_unaccent', $1)
|| plainto_tsquery('pt_unaccent', $1)
```

### 1.3 O "Feature Flag Natural" já existe

| Valor de `ftsLanguages` | Comportamento | Estado |
|------------------------|---------------|--------|
| `["simple"]` (padrão) | Somente `multilingual` — idêntico ao pré-feature | **Feature OFF** |
| `["english", "portuguese"]` | Multilingual + stemming EN + stemming PT | **Feature ON** |
| `["portuguese"]` | Multilingual + stemming PT apenas | Feature parcialmente ON |

**Observação crítica:** `["simple"]` e `["multilingual"]` são **explicitamente filtrados** nos helpers (`lang !== "simple" && lang !== "multilingual"`), garantindo que nenhum layer extra é adicionado com o padrão.

---

## 2. Análise de Impacto no GIN Index e Armazenamento

### 2.1 Impacto quando Feature está OFF

Com `ftsLanguages: ["simple"]` (default):
- `fts_vector` contém apenas os 3 layers `multilingual` (A/B/C)
- GIN index: tamanho normal (baseline)
- Storage: sem duplicação

### 2.2 Impacto quando Feature está ON

Com `ftsLanguages: ["english", "portuguese"]`:
- `fts_vector` contém os 3 layers `multilingual` + 2 layers de stemming (EN/PT)
- GIN index: **≈2-3x maior** que o baseline
  - Razão: tokens stemados são vocabulário adicional no índice invertido
  - Ex: "installation" gera tokens `{install}` (EN stem) + `{installation}` (multilingual)
- Storage: cada row de documento tem tsvector ~2-3x mais pesado

### 2.3 O Problema de Consistência ao Toggling

**Cenário crítico:** Toggling `ftsLanguages` em produção sem reindexação.

```
Estado do banco após toggle parcial:
┌──────────────────────────────────────────────────────────┐
│  Doc 1 (indexado com simple): fts_vector = {react,hook}  │
│  Doc 2 (indexado com EN):     fts_vector = {react,hook,  │
│                                 react,hook (stems)}       │
└──────────────────────────────────────────────────────────┘
Query: "reacts" (stemmed EN)
  → Doc 1: ❌ não encontra (stem não está no tsvector)
  → Doc 2: ✅ encontra
```

**Consequência:** O GIN index fica em estado misto — parte dos documentos tem stemming, parte não. Busca semântica funciona inconsistentemente por biblioteca ou por data de indexação.

### 2.4 Mitigação Necessária

Não existe método de reindexação incremental no `PostgresDocumentStore`. A única forma atual de garantir consistência ao toggling é:
1. Deletar todos os documentos da biblioteca (`deleteLibrary`)
2. Re-scrape completo

Isso é **costoso** para bibliotecas grandes e **não-trivial** para o usuário.

---

## 3. Opções de Implementação do Feature Flag

### Opção A: Constante em `src/utils/featureFlags.ts` (Recomendada)

**Conceito:** Criar um arquivo central de feature flags com uma constante boolean que controla o valor padrão de `ftsLanguages`.

**Implementação:**

```typescript
// src/utils/featureFlags.ts

/**
 * Feature flag: Enable multilingual FTS stemming (English + Portuguese).
 *
 * When true, document indexing includes additional tsvector layers with
 * pt_unaccent (Portuguese) and en_unaccent (English) stemmers, enabling
 * morphological matching (e.g., "install" matches "installation").
 *
 * When false (default), only the 'multilingual' config is used (simple
 * token matching + accent normalization).
 *
 * WARNING: Toggling this flag with existing data causes index inconsistency.
 * All libraries must be re-scraped after changing this value.
 *
 * Prerequisites: migration 014-add-fts-stemming-configs must be applied.
 */
export const FEATURE_FLAGS = {
  FTS_MULTILINGUAL_STEMMING: false, // Set to true to enable
} as const;
```

**Uso em `src/utils/config.ts`:**

```typescript
import { FEATURE_FLAGS } from "./featureFlags.ts";

// O flag controla o DEFAULT — o usuário ainda pode sobrescrever via YAML/env
ftsLanguages: FEATURE_FLAGS.FTS_MULTILINGUAL_STEMMING
  ? ["portuguese", "english"]
  : ["simple"],
```

**Prós:**
- ✅ Visibilidade total: arquivo dedicado, comentário exaustivo
- ✅ Baixa implementação (< 10 linhas)  
- ✅ Rastreável via `git blame` e `git log`
- ✅ Não altera a API pública — `ftsLanguages` ainda pode ser sobrescrito
- ✅ Sem risco de regressão

**Contras:**
- ⚠️ Não resolve o problema de consistência do índice (toggling ainda requer reindex)
- ⚠️ Ainda é um boolean hardcoded — requer rebuild para trocar (próximo deploy)
- ⚠️ Não há mecanismo de rollback suave para dados já indexados

---

### Opção B: Env Variable como Flag (Runtime toggle)

**Conceito:** `FEATURE_FTS_MULTILINGUAL_STEMMING=true|false` no `.env`.

```typescript
export const FEATURE_FLAGS = {
  FTS_MULTILINGUAL_STEMMING:
    process.env.FEATURE_FTS_MULTILINGUAL_STEMMING === "true",
} as const;
```

**Prós:**
- ✅ Pode ser alterado sem rebuild
- ✅ Configurável por ambiente (dev/staging/prod)

**Contras:**
- ⚠️ Runtime toggle ainda causa inconsistência de índice se há dados em produção
- ⚠️ Adiciona mais uma env var ao sistema (já tem muitas)
- ⚠️ É confuso ter tanto `FEATURE_FTS_MULTILINGUAL_STEMMING` quanto `SEARCH_FTS_LANGUAGES`

---

### Opção C: Adicionar CLI Command `reindex` (Complemento)

**Conceito:** Adicionar `docs-mcp reindex [--library X] [--version Y]` ao CLI para permitir reindexação in-place sem re-scrape.

**O que faria:**
```typescript
// PostgresDocumentStore
async rebuildFtsIndex(libraryId?: number): Promise<number> {
  const tsvectorSql = this.buildFtsTsvectorSql(this.config.search.ftsLanguages);
  const result = await this.query(`
    UPDATE documents d
    SET fts_vector = ${tsvectorSql}
    FROM pages p
    JOIN versions v ON p.version_id = v.id
    JOIN libraries l ON v.library_id = l.id
    WHERE d.page_id = p.id
    ${libraryId ? `AND l.id = $1` : ""}
  `, libraryId ? [libraryId] : []);
  return result.rowCount ?? 0;
}
```

**Prós:**
- ✅ Resolve o problema de consistência do índice
- ✅ Permite toggling limpo e seguro
- ✅ Útil além do feature flag (manutenção geral)

**Contras:**
- ⚠️ Maior esforço de implementação (Store + CLI + testes)
- ⚠️ VACUUM FULL ainda pode ser necessário para liberar storage após desabilitar

---

### Opção D: Não fazer nada (Status quo)

A configuração `ftsLanguages` **já é o feature flag**. O comportamento padrão `["simple"]` é off. Documentar isso no README é suficiente para validação.

**Prós:**
- ✅ Zero esforço
- ✅ A lógica já funciona corretamente

**Contras:**
- ⚠️ Baixa visibilidade — difícil descobrir sem ler o código
- ⚠️ Sem documentação clara do impacto de toggling
- ⚠️ Não atende ao objetivo de "feature flag em nível de código"

---

## 4. Análise Comparativa

| Critério | Opção A (featureFlags.ts) | Opção B (env var) | Opção C (+reindex) | Opção D (status quo) |
|---------|--------------------------|-------------------|-------------------|----------------------|
| Visibilidade no código | ✅ Alta | ✅ Alta | ✅ Alta | ❌ Baixa |
| Esforço de implementação | ✅ Baixo (~10 linhas) | ✅ Baixo | ⚠️ Médio | ✅ Zero |
| Resolve inconsistência de índice | ❌ Não | ❌ Não | ✅ Sim | ❌ Não |
| Risco de regressão | ✅ Nenhum | ✅ Nenhum | ⚠️ Baixo | ✅ Nenhum |
| Granularidade de controle | ⚠️ Por deploy | ✅ Por ambiente | ✅ Por biblioteca | ⚠️ Por deploy |
| Comprometimento do GIN | ❌ Não resolve | ❌ Não resolve | ✅ Resolve parcialmente | ❌ Não resolve |
| Rastreabilidade | ✅ Git blame | ⚠️ Env vars | ✅ Git + logs | ❌ Indireta |

---

## 5. Problemas Estruturais Identificados

### 5.1 Ausência de Reindexação Incremental

**Problema:** Não há `rebuildFtsIndex()` no `PostgresDocumentStore`. Isso torna qualquer mudança no `ftsLanguages` um evento de alto custo operacional (re-scrape completo).

**Impacto no objetivo do usuário:** A "validação com o tempo" não é possível de forma ágil hoje. Ativar a feature para um conjunto de bibliotecas, medir resultados, e reverter requer re-scrape completo de cada uma.

### 5.2 Migração 014 é Permanente

A migration `014-add-fts-stemming-configs.sql` cria as configurações FTS no PostgreSQL. Uma vez aplicada, os objects `pt_unaccent` e `en_unaccent` existem no banco. Isso é inofensivo quando `ftsLanguages: ["simple"]` — as configs ficam idle. Não há migration de rollback.

**Impacto:** O banco sempre terá a capacidade técnica. O flag controla o uso, não a existência.

### 5.3 VACUUM após desabilitar

Ao desabilitar a feature e reindexar, os tsvectors vazios anteriores liberam espaço nas rows mas o storage físico não é recuperado imediatamente. Requer:
```sql
VACUUM FULL documents;
```
ou `REINDEX INDEX idx_documents_fts` para reconstruir o GIN compactado.

---

## 6. Recomendação

### Implementação Mínima (Imediata, baixo risco)

**Passo 1:** Criar `src/utils/featureFlags.ts` com a constante `FTS_MULTILINGUAL_STEMMING: false` e documentação clara do impacto.

**Passo 2:** Atualizar `src/utils/config.ts` para usar o flag como fallback default do `ftsLanguages` (sem remover a possibilidade de override via config).

Essa implementação:
- Não altera nenhum comportamento existente (feature continua off por padrão)
- Passa em todos os testes atuais sem modificação
- Cria um ponto de controle visível e auditável no código
- Atende ao objetivo de "feature flag em nível de código"
- Tem zero risco de regressão

### Implementação Complementar (Opcional, médio prazo)

**Passo 3:** Adicionar `rebuildFtsIndex()` ao `PostgresDocumentStore` + comando CLI `docs-mcp reindex` para permitir toggling seguro e validação granular por biblioteca.

Sem o Passo 3, o objetivo de "validar com o tempo" fica operacionalmente custoso — mas ainda é possível (requer re-scrape manual per-library).

---

## 7. Diagrama de Estado do Feature Flag

```
Estado inicial após migração aplicada:
┌─────────────────────────────────────────────────────────┐
│  FEATURE_FLAGS.FTS_MULTILINGUAL_STEMMING = false         │
│  ftsLanguages padrão: ["simple"]                         │
│  Comportamento: multilingual only (baseline)             │
│  GIN index: tamanho normal                               │
└─────────────────────────────────────────────────────────┘

Para habilitar (validação):
  1. Setar FEATURE_FLAGS.FTS_MULTILINGUAL_STEMMING = true
  2. Deploy
  3. Reindexar bibliotecas (re-scrape ou futuro rebuildFtsIndex)
  
┌─────────────────────────────────────────────────────────┐
│  FEATURE_FLAGS.FTS_MULTILINGUAL_STEMMING = true          │
│  ftsLanguages padrão: ["portuguese", "english"]          │
│  Comportamento: multilingual + stemming EN/PT            │
│  GIN index: ≈2-3x maior                                  │
└─────────────────────────────────────────────────────────┘

Para desabilitar (rollback):
  1. Setar FEATURE_FLAGS.FTS_MULTILINGUAL_STEMMING = false
  2. Deploy
  3. Reindexar bibliotecas (necessário para limpar tsvectors grandes)
  4. VACUUM FULL ou REINDEX para recuperar espaço
```

---

## 8. Arquivos Afetados pela Implementação Recomendada

| Arquivo | Ação | Complexidade |
|---------|------|-------------|
| `src/utils/featureFlags.ts` | CRIAR (novo) | Muito baixa |
| `src/utils/config.ts` | MODIFICAR default de `ftsLanguages` | Mínima |
| `src/utils/featureFlags.test.ts` | CRIAR testes de sanidade | Baixa |

**Total de linhas de código estimadas:** < 50 linhas.

---

## 9. Conclusão

A feature `fts-multilingual-stemming` foi implementada corretamente e de forma retrocompatível. A criação de um feature flag explícito em nível de código é **altamente viável** com esforço mínimo.

O ponto crítico que a implementação atual **não resolve** é a **reindexação incremental** — necessária para toggling seguro sem custos de re-scrape. Para o objetivo de "validar com o tempo a necessidade do multilíngue", recomenda-se implementar também o `rebuildFtsIndex()` antes de habilitar a feature em produção, caso haja intenção de reverter sem re-scrape.

**Viabilidade geral:** ✅ Alta  
**Risco:** 🟢 Baixo (zero se não reindexar ao toggling)  
**Esforço de implementação do flag:** ~2h de desenvolvimento incluindo testes

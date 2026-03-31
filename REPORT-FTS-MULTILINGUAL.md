# Relatório: Análise de FTS Multilíngue (Português + Inglês)

**Projeto:** `arabold/docs-mcp-server`  
**Data:** 30/03/2026  
**Escopo:** Avaliar a eficiência do Full-Text Search (FTS) atual para cenários bilíngues (PT/EN) e propor melhorias.

---

## Sumário Executivo

O projeto utiliza uma configuração FTS customizada chamada `multilingual` no PostgreSQL, baseada no dicionário `simple` com extensão `unaccent`. Essa abordagem é **funcional para buscas exatas e sem acento**, mas **não oferece stemming linguístico**, o que reduz significativamente a eficiência de descoberta de conteúdo em cenários onde os usuários buscam usando variações morfológicas de palavras (conjugações verbais, plurais, diminutivos, etc.).

**Veredicto:** A arquitetura atual **suporta parcialmente** o cenário multilíngue, mas **há melhorias viáveis** sem quebrar a arquitetura. A infraestrutura de configuração `ftsLanguages` já existe no schema de config mas **não está implementada no código**.

---

## 1. Arquitetura FTS Atual

### 1.1 Configuração de Text Search (`multilingual`)

**Arquivo:** `db/migrations-pg/000-initial-schema.sql` (linhas 9–28)

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION multilingual (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION multilingual
  ALTER MAPPING FOR hword, hword_part, word
  WITH unaccent, simple;
```

**Componentes:**
| Componente | Função |
|------------|--------|
| `simple` (base) | Tokenização básica sem stemming — converte para lowercase e retorna o token como está |
| `unaccent` | Remove acentos: `ã→a`, `ç→c`, `é→e`, `ü→u`, etc. |

### 1.2 Indexação de Documentos

**Arquivo:** `src/store/PostgresDocumentStore.ts` (linhas 639–643)

Cada chunk é indexado com pesos diferenciados:

```sql
INSERT INTO documents (..., fts_vector)
VALUES ($1, $2, $3::jsonb, $4,
  setweight(to_tsvector('multilingual', coalesce($5, '')), 'A') ||  -- Título da página
  setweight(to_tsvector('multilingual', coalesce($6, '')), 'B') ||  -- Path hierárquico (seções)
  setweight(to_tsvector('multilingual', coalesce($7, '')), 'C'))    -- Conteúdo do chunk
```

| Peso | Campo | Prioridade |
|------|-------|------------|
| A | Título da página | Alta |
| B | Caminho de seções (breadcrumbs) | Média |
| C | Conteúdo do chunk | Baixa |

### 1.3 Consulta de Busca

**Arquivo:** `src/store/PostgresDocumentStore.ts` (linhas 838–855)

```sql
SELECT ...,
  ts_rank_cd(d.fts_vector, plainto_tsquery('multilingual', $1)) as fts_score
FROM documents d
  JOIN pages p ON d.page_id = p.id
  JOIN versions v ON p.version_id = v.id
  JOIN libraries l ON v.library_id = l.id
WHERE l.name = $2 AND v.name = $3
  AND d.fts_vector @@ plainto_tsquery('multilingual', $1)
  AND NOT (d.metadata->'types' @> '["structural"]'::jsonb)
ORDER BY fts_score DESC
LIMIT $4
```

**Funções-chave:**
- `plainto_tsquery()` — converte input em tsquery com semântica AND (todos os termos devem estar presentes)
- `@@` — operador de match FTS
- `ts_rank_cd()` — ranking por cover density (0–1)

### 1.4 Configuração `ftsLanguages` (NÃO IMPLEMENTADA)

**Arquivo:** `src/utils/config.ts` (linha 105)

```typescript
ftsLanguages: ["simple"] as string[],
```

Esta configuração está **definida no schema Zod** (linha 283) e **documentada** em `docs/deployment/postgresql.md`, mas **nunca é consumida pelo código**. Todas as queries SQL usam `'multilingual'` hardcoded.

---

## 2. Análise de Impacto no Cenário PT/EN

### 2.1 O que FUNCIONA hoje

| Cenário | Funciona? | Exemplo |
|---------|-----------|---------|
| Busca exata (termo idêntico ao conteúdo) | ✅ Sim | Query "instalação" → match "instalação" |
| Busca sem acento | ✅ Sim | Query "instalacao" → match "instalação" |
| Busca case-insensitive | ✅ Sim | Query "React" → match "react" |
| Busca multi-termo (AND) | ✅ Sim | Query "install react" → match documentos com ambos |
| Termos técnicos (API, HTTP, JSON) | ✅ Sim | Não precisam de stemming |
| Nomes de funções/classes | ✅ Sim | Exatos por natureza |

### 2.2 O que NÃO FUNCIONA hoje

| Cenário | Funciona? | Problema |
|---------|-----------|----------|
| Stemming em português | ❌ Não | Query "configurações" NÃO encontra "configuração" |
| Stemming em inglês | ❌ Não | Query "installing" NÃO encontra "installation" |
| Plurais em português | ❌ Não | Query "bibliotecas" NÃO encontra "biblioteca" |
| Plurais em inglês | ❌ Não | Query "components" NÃO encontra "component" |
| Conjugações verbais PT | ❌ Não | Query "configurar" NÃO encontra "configurado" |
| Conjugações verbais EN | ❌ Não | Query "configure" NÃO encontra "configured" |
| Stop words | ❌ Parcial | "the", "a", "o", "de" são indexados como tokens normais, ocupando espaço sem valor |

### 2.3 Cenários Problemáticos Concretos

**Exemplo 1:** Documentação React em português
- Conteúdo indexado: *"Configuração do ambiente de desenvolvimento"*
- Busca do usuário: *"configurar ambiente"*
- **Resultado com `simple`:** ❌ Não encontra ("configurar" ≠ "configuração")
- **Resultado com `portuguese`:** ✅ Encontraria (ambos stemam para "configur")

**Exemplo 2:** Documentação Next.js em inglês
- Conteúdo indexado: *"Installing dependencies and configuring the project"*
- Busca do usuário: *"install dependency"*
- **Resultado com `simple`:** ❌ Não encontra ("install" ≠ "installing", "dependency" ≠ "dependencies")
- **Resultado com `english`:** ✅ Encontraria (stemmers normalizam corretamente)

**Exemplo 3:** Busca cross-language
- Conteúdo indexado (EN): *"Component lifecycle methods"*
- Busca do usuário (PT): *"métodos do ciclo de vida"*
- **Resultado:** ❌ Não encontra em nenhuma configuração (FTS não faz tradução)
- **Nota:** Este cenário requer busca semântica (embeddings), não FTS

---

## 3. Estratégias de Melhoria

### 3.1 Estratégia A: Multi-Config TSVector (Recomendada)

**Conceito:** Criar múltiplos tsvectors (um por idioma) e combiná-los em um único vetor OR-concatenado.

**Mudança na migration:**
```sql
-- Criar configs de stemming por idioma (se não existirem)
DO $$
BEGIN
  -- Config para português com unaccent
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese)';
    EXECUTE 'ALTER TEXT SEARCH CONFIGURATION pt_unaccent
               ALTER MAPPING FOR hword, hword_part, word
               WITH unaccent, portuguese_stem';
  END IF;

  -- Config para inglês com unaccent  
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'en_unaccent') THEN
    EXECUTE 'CREATE TEXT SEARCH CONFIGURATION en_unaccent (COPY = english)';
    EXECUTE 'ALTER TEXT SEARCH CONFIGURATION en_unaccent
               ALTER MAPPING FOR hword, hword_part, word
               WITH unaccent, english_stem';
  END IF;
END
$$;
```

**Mudança na indexação (INSERT):**
```sql
INSERT INTO documents (..., fts_vector)
VALUES ($1, $2, $3::jsonb, $4,
  -- Manter o multilingual (simple+unaccent) para match exato
  setweight(to_tsvector('multilingual', coalesce($5, '')), 'A') ||
  setweight(to_tsvector('multilingual', coalesce($6, '')), 'B') ||
  setweight(to_tsvector('multilingual', coalesce($7, '')), 'C') ||
  -- Adicionar stemming em português  
  setweight(to_tsvector('pt_unaccent', coalesce($7, '')), 'D') ||
  -- Adicionar stemming em inglês
  setweight(to_tsvector('en_unaccent', coalesce($7, '')), 'D'))
```

**Mudança na busca (SELECT):**
```sql
WHERE d.fts_vector @@ (
  plainto_tsquery('multilingual', $1)
  || plainto_tsquery('pt_unaccent', $1)  
  || plainto_tsquery('en_unaccent', $1)
)
```

**Prós:**
- ✅ Retrocompatível — o tsvector existente `multilingual` continua funcionando
- ✅ Stemming PT e EN funcionam simultaneamente
- ✅ Não requer detecção de idioma
- ✅ Usa a coluna `fts_vector` e índice GIN existentes
- ✅ Uma única coluna, um único índice

**Contras:**
- ⚠️ Tsvector fica maior (≈2-3x), aumentando uso de disco e memória do GIN index
- ⚠️ Pode gerar falsos positivos (stem colisões entre idiomas)
- ⚠️ Requer reindexação de todos os documentos existentes

**Viabilidade:** ✅ **Alta** — mudanças localizadas em 2 arquivos (migration + PostgresDocumentStore.ts)

---

### 3.2 Estratégia B: Colunas Separadas por Idioma

**Conceito:** Adicionar colunas `fts_vector_pt` e `fts_vector_en` separadas.

**Mudança no schema:**
```sql
ALTER TABLE documents ADD COLUMN fts_vector_pt tsvector;
ALTER TABLE documents ADD COLUMN fts_vector_en tsvector;

CREATE INDEX idx_documents_fts_pt ON documents USING GIN(fts_vector_pt);
CREATE INDEX idx_documents_fts_en ON documents USING GIN(fts_vector_en);
```

**Mudança na busca:**
```sql
WHERE (
  d.fts_vector @@ plainto_tsquery('multilingual', $1)
  OR d.fts_vector_pt @@ plainto_tsquery('portuguese', $1)
  OR d.fts_vector_en @@ plainto_tsquery('english', $1)
)
```

**Prós:**
- ✅ Índices menores e mais eficientes por idioma
- ✅ Possibilita ranking diferenciado por idioma

**Contras:**
- ❌ 3 índices GIN (3x memória para índices)
- ❌ Query mais complexa com OR entre colunas
- ❌ Maior mudança no schema e código
- ❌ A configuração `ftsLanguages` precisaria ser dinâmica (quantas colunas criar?)

**Viabilidade:** ⚠️ **Média** — mais invasivo, mas possível

---

### 3.3 Estratégia C: Ativar a Config `ftsLanguages` Existente

**Conceito:** Implementar a lógica que a configuração `ftsLanguages` já promete na documentação.

**Mudança no código** (`PostgresDocumentStore.ts`):
```typescript
// Ao indexar:
const ftsConfigs = config.search.ftsLanguages; // ["english", "portuguese"]
const tsvectorParts = ftsConfigs.map((lang, i) => {
  const weight = i === 0 ? "'A'" : "'D'"; // Primeiro idioma tem prioridade
  return `setweight(to_tsvector('${lang}', coalesce($${paramIdx}, '')), ${weight})`;
}).join(' || ');

// Ao buscar:
const tsqueryParts = ftsConfigs.map(lang => 
  `plainto_tsquery('${lang}', $1)`
).join(' || ');
```

**Prós:**
- ✅ Usa infraestrutura de config que já existe
- ✅ Configurável pelo usuário
- ✅ Documentação já existe

**Contras:**
- ⚠️ Requer sanitização robusta dos nomes de config (risco de SQL injection se não parametrizado)
- ⚠️ Configs do PostgreSQL (`english`, `portuguese`) precisam existir no banco
- ⚠️ Mudança de comportamento para quem já usa o default `["simple"]`

**Viabilidade:** ✅ **Alta** — é essencialmente implementar o que a documentação já promete

---

### 3.4 Estratégia D: Busca Combinada OR (Query Rewriting)

**Conceito:** Em vez de mudar a indexação, expandir a query no lado do application.

**Mudança no código:**

Usar `websearch_to_tsquery` ou construir tsquery manualmente com OR entre termos normais e stems:

```sql
-- Em vez de:
plainto_tsquery('multilingual', 'installing components')

-- Usar:
to_tsquery('multilingual', 'installing | install | components | component')
```

**Implementação:** Fazer um pré-processamento da query no TypeScript usando uma biblioteca de stemming (e.g., `snowball-stmmer`, `natural`):

```typescript
import { PorterStemmer } from 'natural';
import { stem as ptStem } from 'snowball-stemmer/portuguese';

function expandQuery(query: string): string {
  const words = query.split(/\s+/).filter(Boolean);
  const expanded = words.flatMap(word => {
    const stems = new Set([word.toLowerCase()]);
    stems.add(PorterStemmer.stem(word));  // English stem
    stems.add(ptStem(word));              // Portuguese stem
    return [...stems];
  });
  return expanded.join(' | ');
}

// SQL:
`d.fts_vector @@ to_tsquery('multilingual', $1)`
// com $1 = expandQuery(userQuery)
```

**Prós:**
- ✅ Não requer mudança no schema ou reindexação
- ✅ Sem aumento no tamanho do índice
- ✅ Retrocompatível

**Contras:**
- ❌ Adiciona dependência de bibliotecas de NLP no servidor
- ❌ Stemming no application pode divergir do PostgreSQL
- ❌ Expansão de query pode gerar muitos termos → perda de precisão
- ⚠️ Requer cuidado com SQL injection ao montar `to_tsquery` manualmente

**Viabilidade:** ⚠️ **Média** — funciona, mas é frágil e pode divergir

---

## 4. Comparação das Estratégias

| Critério | A: Multi-Config | B: Colunas Separadas | C: Ativar ftsLanguages | D: Query Rewriting |
|----------|-----------------|---------------------|----------------------|-------------------|
| Eficiência de busca | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Simplicidade | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| Retrocompatibilidade | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Uso de disco/memória | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Manutenibilidade | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| Invasividade no código | Baixa | Alta | Baixa | Média |
| Reindexação necessária | Sim | Sim | Sim | Não |

---

## 5. Recomendação

### Abordagem Recomendada: Estratégia C (Ativar `ftsLanguages`) + Merge com Multilingual

A abordagem mais pragmática e alinhada com a arquitetura existente:

1. **Manter** a config `multilingual` (simple + unaccent) como base para buscas exatas
2. **Implementar** o consumo de `ftsLanguages` no `PostgresDocumentStore`
3. **Gerar** tsvectors combinados: `multilingual` + configs de `ftsLanguages`
4. **Buscar** com tsquery OR entre todas as configs

**Exemplo de implementação no `PostgresDocumentStore.ts`:**

```typescript
// Na indexação:
private buildTsvectorSql(configs: string[]): string {
  // Sempre inclui 'multilingual' para match exato + unaccent
  const parts = [
    `setweight(to_tsvector('multilingual', coalesce($5, '')), 'A')`,
    `setweight(to_tsvector('multilingual', coalesce($6, '')), 'B')`,
    `setweight(to_tsvector('multilingual', coalesce($7, '')), 'C')`,
  ];
  
  // Adiciona stemming para cada idioma configurado
  for (const lang of configs) {
    if (lang !== 'simple' && lang !== 'multilingual') {
      parts.push(`to_tsvector('${lang}', coalesce($7, ''))`);
    }
  }
  
  return parts.join(' || ');
}

// Na busca:
private buildTsquerySql(configs: string[]): string {
  const parts = [`plainto_tsquery('multilingual', $1)`];
  for (const lang of configs) {
    if (lang !== 'simple' && lang !== 'multilingual') {
      parts.push(`plainto_tsquery('${lang}', $1)`);
    }
  }
  return parts.join(' || ');
}
```

**Configuração do usuário:**
```yaml
search:
  ftsLanguages: ["english", "portuguese"]
```

**Impacto estimado:**
- Arquivos modificados: 2 (`PostgresDocumentStore.ts` + nova migration)
- Linhas alteradas: ~30–50
- Reindexação: Necessária para documentos existentes (pode ser feita via refresh)
- Compatibilidade: 100% retrocompatível (default `["simple"]` mantém comportamento atual)

---

## 6. Considerações sobre `plainto_tsquery` e AND Semantics

Um ponto importante: `plainto_tsquery` usa semântica **AND** — todos os termos devem estar presentes. Isso significa:

- Query `"install react hooks"` → `'install' & 'react' & 'hooks'`
- **Todos** os termos devem existir no documento para haver match

No cenário multilíngue com stemmers, isso é benéfico porque:
- `plainto_tsquery('english', 'installing components')` → `'instal' & 'compon'` (stems)
- O tsvector do documento `to_tsvector('english', 'Installation of Components')` → `'instal' 'compon'`
- ✅ Match ocorre corretamente

Porém, se o conteúdo é em um idioma e a busca em outro, **nenhum stemmer resolve** — seria necessário busca semântica (embeddings/vetores).

---

## 7. Nota sobre Stop Words

Com a config `simple` atual, stop words **não são removidas**. Palavras como "the", "a", "o", "de", "do" são indexadas normalmente. Isso tem dois efeitos:

1. **Negativo:** Índice maior, com tokens sem valor semântico
2. **Positivo:** Buscas por frases exatas que incluem stop words funcionam

Com stemmers (`english`, `portuguese`), stop words são removidas automaticamente, o que:
- Reduz o tamanho do índice
- Melhora a precisão do ranking
- Pode causar confusão se o usuário busca por uma stop word (raro)

---

## 8. Riscos e Mitigações

| Risco | Mitigação |
|-------|-----------|
| SQL injection via nomes de config | Validar contra lista branca de configs PostgreSQL válidas |
| Reindexação longa em bases grandes | Implementar como migration incremental ou via pipeline de refresh |
| Falsos positivos por stem collision | Manter `multilingual` com peso maior (A/B/C) e stemmers com peso menor |
| Config `portuguese`/`english` não existe no PG | Ambos são built-in do PostgreSQL, sempre disponíveis |
| Aumento de tamanho do fts_vector | Monitorar; no pior caso ~2-3x (aceitável para o ganho de recall) |

---

## 9. Conclusão

| Pergunta | Resposta |
|----------|---------|
| O FTS atual funciona para PT/EN? | **Parcialmente** — funciona para termos exatos e sem acento |
| É viável melhorar com a arquitetura atual? | **Sim** — a infraestrutura de config já existe |
| Qual a melhor estratégia? | **Ativar `ftsLanguages`** com stemmers `english` + `portuguese` |
| Requer refatoração grande? | **Não** — ~2 arquivos, ~30-50 linhas |
| Resolve busca cross-language (PT query → EN content)? | **Não** — isso requer busca semântica/embeddings |
| Requer reindexação? | **Sim** — documentos existentes precisam ser reprocessados |

A implementação é **viável, localizada e retrocompatível**, representando um ganho significativo de recall para o cenário bilíngue PT/EN.

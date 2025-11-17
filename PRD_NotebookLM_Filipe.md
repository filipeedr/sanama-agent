# 🧩 PRD --- Sistema de Leitura Inteligente de PDFs com RAG (Estilo NotebookLM)

**Versão:** 1.0\
**Responsável:** Filipe Esteves\
**Data:** 16/11/2025\
**Status:** Draft

## 1. Resumo Executivo

Este projeto descreve a criação de uma plataforma que permite que
usuários enviem PDFs --- incluindo documentos digitalizados --- e façam
perguntas sobre o conteúdo, recebendo respostas embasadas em trechos
reais extraídos dos arquivos.

O sistema utiliza um pipeline composto por OCR, extração de texto,
chunking, embeddings e busca vetorial (RAG), orquestrado sobre Supabase,
com chat alimentado por LLMs (ex: GPT-4.1/4o, Claude 3.5, Gemini 1.5 via
OpenRouter).

O objetivo é replicar a experiência do NotebookLM, oferecendo:

-   compreensão profunda de PDFs escaneados\
-   respostas fundamentadas\
-   coleções de documentos (notebooks)\
-   resumos automáticos\
-   rastreabilidade da fonte de cada resposta ("de qual página veio")

## 2. Objetivo do Produto

Criar um sistema que permita:

1.  Upload de PDFs e imagens digitalizadas.\
2.  Extração automática do conteúdo textual (com OCR quando
    necessário).\
3.  Processamento e armazenamento estruturado de trechos (chunks).\
4.  Indexação vetorial para busca semântica.\
5.  Interface de chat com respostas baseadas **somente** no material
    enviado.\
6.  Geração opcional de resumos, insights e notas guiadas (style:
    NotebookLM).\
7.  Suporte a coleções de documentos ("Notebooks").

O produto deve ser rápido, confiável, seguro e escalável.

## 3. Problema a Ser Resolvido

Usuários frequentemente lidam com:

-   PDFs longos ou complexos\
-   Dificuldade em localizar rapidamente informações específicas\
-   PDFs escaneados impossíveis de serem pesquisados\
-   Sínteses manuais demoradas

## 4. Proposta de Solução

Criar uma plataforma que recebe PDFs, processa seu conteúdo em
background e disponibiliza:

-   leitura\
-   busca\
-   interpretação\
-   chat orientado a fontes\
-   organização em notebooks

## 5. Arquitetura de Alto Nível

    FRONTEND (Next.js)
        ↓ Upload
    SUPABASE STORAGE
        ↓ document_id
    WORKER (n8n/Python)
        ↓ OCR + Extração + Chunking
    PGVECTOR (Supabase)
        ↓ Busca vetorial
    CHAT SERVICE (LLM + RAG)
        ↓
    UI de Chat

## 6. Escopo Funcional

### 6.1 Upload

-   Envio de PDF/JPG/PNG\
-   Validação\
-   Registro em `documents`

### 6.2 Pipeline

-   OCR automático\
-   Extração de texto\
-   Chunking\
-   Embeddings\
-   Sumário automático (opcional)

### 6.3 Notebooks

-   Criar coleções\
-   Chat baseado em múltiplos documentos

### 6.4 Chat

-   Busca vetorial\
-   Prompt estruturado\
-   Resposta com fontes

### 6.5 Interface

-   Viewer de PDF\
-   Highlight das páginas citadas

## 7. Requisitos

### Funcionais

RF01 --- Upload\
RF02 --- OCR\
RF03 --- Extração\
RF04 --- Normalização\
RF05 --- Chunking\
RF06 --- Embeddings\
RF07 --- Busca Vetorial\
RF08 --- Chat\
RF09 --- Referências\
RF10 --- Notebooks\
RF11 --- Sumários\
RF12 --- Histórico

### Não Funcionais

RNF01 --- Latência\
RNF02 --- Escalabilidade\
RNF03 --- Segurança\
RNF04 --- Confiabilidade\
RNF05 --- Privacidade

## 8. User Stories

US01 --- Upload\
US02 --- OCR\
US03 --- Busca inteligente\
US04 --- Chat com fontes\
US05 --- Notebooks\
US06 --- Sumários\
US07 --- Compreensão de tabelas

## 9. Fluxos

### Fluxo 1 --- Upload → Pronto

### Fluxo 2 --- Chat

## 10. Banco de Dados

Tabelas:

-   `documents`
-   `document_chunks`
-   `notebooks`
-   `notebook_documents`
-   `chats`
-   `chat_messages`

## 11. KPIs

-   Tempo de processamento\
-   Latência média\
-   Precisão da busca\
-   \% PDFs escaneados corretamente\
-   Engajamento no chat

## 12. Roadmap

MVP\
Versão Avançada\
Versão NotebookLM-like

## 13. Critérios de Aceite

-   Extração concluída\
-   Chunking OK\
-   Embeddings OK\
-   Busca funcionando\
-   Chat consistente\
-   Referências clicáveis

## 14. Riscos

-   PDFs com layout complexo\
-   PDFs muito grandes\
-   Latência do LLM\
-   Custo de embeddings\
-   Erros no OCR

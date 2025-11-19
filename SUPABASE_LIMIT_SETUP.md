# Configuração do Limite de Documentos no Supabase

Este documento descreve as mudanças necessárias no Supabase para suportar o limite de 50 documentos.

## Mudanças no Schema

As seguintes alterações foram adicionadas ao arquivo `supabase/schema.sql`:

### 1. Função de Validação

Uma função PostgreSQL foi criada para verificar o limite antes de inserir novos documentos:

```sql
create or replace function public.check_document_limit()
returns trigger as $$
declare
  current_count integer;
begin
  -- Conta o número total de documentos
  select count(*) into current_count from public.documents;
  
  -- Se já atingiu o limite de 50, bloqueia a inserção
  if current_count >= 50 then
    raise exception 'Limite de 50 documentos atingido. Exclua documentos antes de adicionar novos.';
  end if;
  
  return new;
end;
$$ language plpgsql;
```

### 2. Trigger de Validação

Um trigger foi criado para executar a validação antes de cada inserção:

```sql
create trigger documents_limit_check
before insert on public.documents
for each row execute procedure public.check_document_limit();
```

## Como Aplicar no Supabase

### Opção 1: Via SQL Editor no Dashboard do Supabase

1. Acesse o dashboard do Supabase
2. Vá em **SQL Editor**
3. Execute o seguinte SQL:

```sql
-- Função para validar o limite de 50 documentos
create or replace function public.check_document_limit()
returns trigger as $$
declare
  current_count integer;
begin
  -- Conta o número total de documentos
  select count(*) into current_count from public.documents;
  
  -- Se já atingiu o limite de 50, bloqueia a inserção
  if current_count >= 50 then
    raise exception 'Limite de 50 documentos atingido. Exclua documentos antes de adicionar novos.';
  end if;
  
  return new;
end;
$$ language plpgsql;

-- Trigger para validar o limite antes de inserir
create trigger documents_limit_check
before insert on public.documents
for each row execute procedure public.check_document_limit();
```

### Opção 2: Via Migração

Se você estiver usando migrações do Supabase CLI, crie uma nova migração:

```bash
supabase migration new add_document_limit
```

E adicione o SQL acima no arquivo de migração criado.

## Como Funciona

1. **Validação no Frontend**: O frontend já valida o limite antes de enviar a requisição
2. **Validação no Backend**: A API também valida o limite antes de processar
3. **Validação no Banco**: O trigger no PostgreSQL garante que mesmo se alguém tentar inserir diretamente no banco, o limite será respeitado

## Testando

Para testar se está funcionando:

1. Tente inserir um documento quando já houver 50 documentos
2. O sistema deve retornar um erro: "Limite de 50 documentos atingido. Exclua documentos antes de adicionar novos."

## Notas Importantes

- O limite é de **50 documentos no total**, não por usuário (já que o sistema é single-tenant)
- O trigger funciona em nível de banco de dados, garantindo que o limite seja sempre respeitado
- Se você precisar alterar o limite no futuro, basta modificar o número `50` na função `check_document_limit()`


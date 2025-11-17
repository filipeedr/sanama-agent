'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type ComponentPropsWithoutRef, type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type IdleDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type IdleCallbackHandle = ReturnType<typeof setTimeout>;
type IdleRequestCallback = (deadline: IdleDeadline) => void;

declare global {
  interface Window {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: { timeout?: number }) => IdleCallbackHandle;
    cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
  }
}

if (typeof window !== 'undefined' && typeof window.requestIdleCallback !== 'function') {
  window.requestIdleCallback = (callback: IdleRequestCallback) => {
    const start = Date.now();
    return window.setTimeout(() => {
      callback({
        didTimeout: false,
        timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
      });
    }, 1);
  };

  window.cancelIdleCallback = (id: IdleCallbackHandle) => {
    window.clearTimeout(id);
  };
}

interface DocumentRecord {
  id: string;
  title: string | null;
  original_filename: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  summary: string | null;
  created_at: string;
}

interface NotebookRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

interface ChatRecord {
  id: string;
  title: string | null;
  notebook_id: string | null;
  last_message_at: string | null;
}

interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  citations?: { label: string; document_id: string; similarity: number }[];
  pending?: boolean;
  metadata?: Record<string, unknown> | null;
}

type FeedbackRating = 'useful' | 'incomplete' | 'incorrect';

interface FeedbackDraft {
  rating: FeedbackRating | null;
  notes: string;
  revisedAnswer: string;
  status: 'idle' | 'saving' | 'sent';
}

export default function Home() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookRecord[]>([]);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingNotebook, setCreatingNotebook] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [notebookForm, setNotebookForm] = useState({ name: '', description: '', documentIds: [] as string[] });
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [deletingNotebookId, setDeletingNotebookId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [showDocumentsPanel, setShowDocumentsPanel] = useState(true);
  const [expandedSummaries, setExpandedSummaries] = useState<Record<string, boolean>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, FeedbackDraft>>({});
  const emptyDraft: FeedbackDraft = { rating: null, notes: '', revisedAnswer: '', status: 'idle' };

  const loadDocuments = useCallback(async () => {
    const response = await fetch('/api/documents', { cache: 'no-store' });
    if (!response.ok) {
      setStatusMessage('Erro ao carregar documentos');
      return;
    }
    const payload = await response.json();
    setDocuments(payload.data ?? []);
  }, []);

  const loadNotebooks = useCallback(async () => {
    const response = await fetch('/api/notebooks', { cache: 'no-store' });
    if (!response.ok) {
      setStatusMessage('Erro ao carregar notebooks');
      return;
    }
    const payload = await response.json();
    setNotebooks(payload.data ?? []);
    if (!selectedNotebookId && payload.data?.length) {
      setSelectedNotebookId(payload.data[0].id);
    }
  }, [selectedNotebookId]);

  const loadChats = useCallback(async () => {
    const response = await fetch('/api/chats', { cache: 'no-store' });
    if (!response.ok) {
      setStatusMessage('Erro ao carregar chats');
      return;
    }
    const payload = await response.json();
    setChats(payload.data ?? []);
  }, []);

  const loadMessages = useCallback(
    async (chatId: string) => {
    const response = await fetch(`/api/chats/${chatId}/messages`, { cache: 'no-store' });
      if (!response.ok) {
        setStatusMessage('Erro ao carregar mensagens');
        return;
      }
      const payload = await response.json();
      setMessages((payload.data ?? []).map((message: ChatMessageRecord) => ({ ...message, pending: false })));
    },
    []
  );

  useEffect(() => {
    loadDocuments();
    loadNotebooks();
    loadChats();
  }, [loadDocuments, loadNotebooks, loadChats]);

  useEffect(() => {
    if (selectedChatId) {
      loadMessages(selectedChatId);
    } else {
      setMessages([]);
    }
  }, [selectedChatId, loadMessages]);

  useEffect(() => {
    setFeedbackDrafts({});
  }, [selectedChatId]);

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    const collectedFiles = formData
      .getAll('files')
      .filter((entry): entry is File => entry instanceof File);
    const fallback = formData.get('file');
    if (fallback instanceof File && !collectedFiles.length) {
      collectedFiles.push(fallback);
    }
    if (!collectedFiles.length) {
      setStatusMessage('Selecione pelo menos um arquivo');
      return;
    }
    setUploading(true);
    setStatusMessage(`Processando ${collectedFiles.length} arquivo(s)...`);
    try {
      const response = await fetch('/api/documents', {
        method: 'POST',
        body: formData
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao enviar');
      }
      await loadDocuments();
      setStatusMessage('Documentos enviados para processamento');
      formElement.reset();
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setUploading(false);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleNotebookSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingNotebook(true);
    try {
      const response = await fetch('/api/notebooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notebookForm)
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao criar notebook');
      }
      setNotebookForm({ name: '', description: '', documentIds: [] });
      await loadNotebooks();
      setStatusMessage('Notebook criado');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setCreatingNotebook(false);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleDocumentSelection = (documentId: string) => {
    setNotebookForm((previous) => {
      const exists = previous.documentIds.includes(documentId);
      return {
        ...previous,
        documentIds: exists
          ? previous.documentIds.filter((id) => id !== documentId)
          : [...previous.documentIds, documentId]
      };
    });
  };

  const filteredChats = useMemo(
    () => chats.filter((chat) => chat.notebook_id === selectedNotebookId),
    [chats, selectedNotebookId]
  );

  useEffect(() => {
    if (!selectedChatId && filteredChats.length) {
      setSelectedChatId(filteredChats[0].id);
    }
  }, [filteredChats, selectedChatId]);

  const handleCreateChat = async (notebookId: string) => {
    try {
      // Garante que o notebook esteja selecionado para que o chat apareça na lista filtrada
      setSelectedNotebookId(notebookId);
      
      const response = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notebookId })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? 'Erro ao criar chat');
      }
      const newChatId = payload.data?.id;
      await loadChats();
      if (newChatId) {
        setSelectedChatId(newChatId);
      }
      setStatusMessage('Chat criado');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    if (deletingDocumentId) return;
    setDeletingDocumentId(documentId);
    try {
      const response = await fetch('/api/documents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [documentId] })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao excluir documento');
      }
      await loadDocuments();
      await loadNotebooks();
      setStatusMessage('Documento removido');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setDeletingDocumentId(null);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const toggleDocumentSummary = (documentId: string) => {
    setExpandedSummaries((previous) => ({
      ...previous,
      [documentId]: !previous[documentId]
    }));
  };

  const handleDeleteNotebook = async (notebookId: string) => {
    if (deletingNotebookId) return;
    setDeletingNotebookId(notebookId);
    try {
      const response = await fetch('/api/notebooks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: notebookId })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao excluir notebook');
      }
      await loadNotebooks();
      await loadChats();
      if (selectedNotebookId === notebookId) {
        setSelectedNotebookId(null);
        setSelectedChatId(null);
        setMessages([]);
      }
      setStatusMessage('Notebook removido');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setDeletingNotebookId(null);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    if (deletingChatId) return;
    setDeletingChatId(chatId);
    try {
      const response = await fetch('/api/chats', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: chatId })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao excluir chat');
      }
      await loadChats();
      if (selectedChatId === chatId) {
        setSelectedChatId(null);
        setMessages([]);
      }
      setStatusMessage('Chat removido');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setDeletingChatId(null);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleSendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedChatId) {
      setStatusMessage('Selecione um chat');
      return;
    }
    const messageContent = chatInput.trim();
    if (!messageContent) return;
    setSendingMessage(true);
    const userTempId = `user-${Date.now()}`;
    const assistantTempId = `assistant-${Date.now()}`;
    setMessages((previous) => [
      ...previous,
      {
        id: userTempId,
        role: 'user',
        content: messageContent,
        created_at: new Date().toISOString(),
        pending: true
      },
      {
        id: assistantTempId,
        role: 'assistant',
        content: 'Gerando resposta...',
        created_at: new Date().toISOString(),
        pending: true
      }
    ]);
    setChatInput('');
    try {
      const response = await fetch(`/api/chats/${selectedChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: messageContent })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao enviar mensagem');
      }
      await loadMessages(selectedChatId);
      await loadChats();
    } catch (error) {
      setMessages((previous) => previous.filter((message) => ![userTempId, assistantTempId].includes(message.id)));
      setStatusMessage((error as Error).message);
    } finally {
      setSendingMessage(false);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const getFeedbackDraft = (messageId: string) => feedbackDrafts[messageId] ?? emptyDraft;

  const handleFeedbackChoice = (messageId: string, rating: FeedbackRating) => {
    setFeedbackDrafts((previous) => {
      const current = previous[messageId] ?? emptyDraft;
      const nextRating = current.rating === rating ? null : rating;
      return {
        ...previous,
        [messageId]: {
          ...current,
          rating: nextRating,
          status: nextRating ? current.status : 'idle'
        }
      };
    });
  };

  const handleFeedbackFieldChange = (
    messageId: string,
    field: 'notes' | 'revisedAnswer',
    value: string
  ) => {
    setFeedbackDrafts((previous) => {
      const current = previous[messageId] ?? emptyDraft;
      return {
        ...previous,
        [messageId]: {
          ...current,
          [field]: value
        }
      };
    });
  };

  const handleSubmitFeedback = async (messageId: string) => {
    if (!selectedChatId) {
      setStatusMessage('Selecione um chat');
      return;
    }
    const draft = getFeedbackDraft(messageId);
    if (!draft.rating) {
      setStatusMessage('Escolha um tipo de feedback');
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
    setFeedbackDrafts((previous) => {
      const current = previous[messageId] ?? emptyDraft;
      return {
        ...previous,
        [messageId]: { ...current, status: 'saving' }
      };
    });
    try {
      const response = await fetch(`/api/chats/${selectedChatId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          rating: draft.rating,
          notes: draft.notes || undefined,
          revisedAnswer: draft.revisedAnswer || undefined
        })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao enviar feedback');
      }
      setFeedbackDrafts((previous) => {
        const current = previous[messageId] ?? emptyDraft;
        return {
          ...previous,
          [messageId]: { ...current, status: 'sent' }
        };
      });
      setStatusMessage('Feedback registrado');
    } catch (error) {
      setFeedbackDrafts((previous) => {
        const current = previous[messageId] ?? emptyDraft;
        return {
          ...previous,
          [messageId]: { ...current, status: 'idle' }
        };
      });
      setStatusMessage((error as Error).message);
    } finally {
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  return (
    <div className="flex h-screen w-full flex-col bg-gray-50 text-gray-900 overflow-hidden">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">Sanama - Hub de Consultas</h1>
            {statusMessage && (
            <span className="rounded-full bg-gray-900 px-3 py-1 text-xs text-white">{statusMessage}</span>
            )}
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Esquerda - Notebooks */}
        <aside className="flex-shrink-0 w-64 border-r border-gray-200 bg-white overflow-y-auto">
          <div className="p-4">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Agentes de consulta</h2>
            </div>
            
            {/* Form de criação de notebook */}
            <form className="mb-6 space-y-3" onSubmit={handleNotebookSubmit}>
              <input
                type="text"
                placeholder="Novo notebook..."
                value={notebookForm.name}
                onChange={(event) => setNotebookForm((prev) => ({ ...prev, name: event.target.value }))}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none"
                required
              />
              <textarea
                placeholder="Descrição (opcional)"
                value={notebookForm.description}
                onChange={(event) => setNotebookForm((prev) => ({ ...prev, description: event.target.value }))}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none resize-none"
                rows={2}
              />
              {documents.length > 0 && (
                <div className="max-h-32 space-y-1.5 overflow-y-auto rounded-lg border border-dashed border-gray-200 p-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">Documentos</p>
                {documents.map((document) => (
                    <label key={document.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-gray-50 p-1 rounded">
                    <input
                      type="checkbox"
                      checked={notebookForm.documentIds.includes(document.id)}
                      onChange={() => handleDocumentSelection(document.id)}
                        className="rounded"
                    />
                      <span className="text-gray-600 truncate">{document.title ?? document.original_filename}</span>
                  </label>
                ))}
              </div>
              )}
              <button
                type="submit"
                disabled={creatingNotebook}
                className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingNotebook ? 'Criando...' : 'Criar agente'}
              </button>
            </form>

            {/* Lista de notebooks */}
            <div className="space-y-1">
              {notebooks.map((notebook) => (
                <div
                  key={notebook.id}
                  className={`rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors ${
                    selectedNotebookId === notebook.id 
                      ? 'bg-gray-100 text-gray-900' 
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                  onClick={() => setSelectedNotebookId(notebook.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{notebook.name}</p>
                      {notebook.description && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">{notebook.description}</p>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCreateChat(notebook.id);
                        }}
                        className="text-xs text-gray-400 hover:text-gray-600"
                        title="Novo chat"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteNotebook(notebook.id);
                        }}
                        disabled={deletingNotebookId === notebook.id}
                        className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                        title="Excluir"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {!notebooks.length && (
                <p className="text-xs text-gray-500 text-center py-4">Nenhum notebook ainda</p>
              )}
            </div>
          </div>
        </aside>

        {/* Área Central - Conversas e Chat */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar de Conversas */}
            <aside className="flex-shrink-0 w-64 border-r border-gray-200 bg-white overflow-y-auto">
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-gray-900">Conversas</h2>
                  {selectedNotebookId && (
                    <button 
                      type="button" 
                      onClick={() => handleCreateChat(selectedNotebookId)} 
                      className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 transition-colors"
                      title="Nova conversa"
                    >
                      + Novo
                    </button>
                  )}
                </div>
                <div className="space-y-1">
              {filteredChats.map((chat) => (
                <div
                  key={chat.id}
                      className={`rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors ${
                        chat.id === selectedChatId 
                          ? 'bg-gray-100 text-gray-900' 
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                      onClick={() => setSelectedChatId(chat.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{chat.title ?? 'Chat sem título'}</p>
                          {chat.last_message_at && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              {new Date(chat.last_message_at).toLocaleTimeString('pt-BR', { 
                                hour: '2-digit', 
                                minute: '2-digit' 
                              })}
                            </p>
                          )}
                        </div>
                    <button
                      type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteChat(chat.id);
                          }}
                      disabled={deletingChatId === chat.id}
                          className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                          title="Excluir"
                    >
                          ×
                    </button>
                  </div>
                </div>
              ))}
                  {!filteredChats.length && (
                    <p className="text-xs text-gray-500 text-center py-4">
                      {selectedNotebookId ? 'Crie um chat para começar' : 'Selecione um notebook'}
                    </p>
                  )}
            </div>
          </div>
            </aside>

            {/* Área de Chat */}
            <div className="flex-1 flex flex-col overflow-hidden bg-white">
              <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                  {messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">Como posso ajudar?</h3>
                        <p className="text-sm text-gray-500">Faça uma pergunta sobre seus documentos</p>
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => {
                      const autoReview = resolveAutoReview(message.metadata ?? null);
                      const coverage = resolveCoverage(message.metadata ?? null);
                      const draft = getFeedbackDraft(message.id);
                      return (
                        <div
                          key={message.id}
                          className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                          {message.role === 'assistant' && (
                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-sm font-semibold">
                              AI
                            </div>
                          )}
                          <div className={`flex-1 max-w-[85%] ${message.role === 'user' ? 'order-2' : ''}`}>
                            <div
                              className={`rounded-2xl px-4 py-3 ${
                                message.role === 'user' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900'
                              }`}
                            >
                              {message.pending && message.role === 'assistant' ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                  <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-gray-400"></span>
                                  <span className="text-sm">Pensando...</span>
                                </div>
                              ) : (
                                <div className={`text-sm leading-relaxed ${message.pending ? 'opacity-70' : ''}`}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                    {formatMessageContent(message.content)}
                                  </ReactMarkdown>
                                </div>
                              )}
                              {message.citations && message.citations.length > 0 && !message.pending && (
                                <div className="mt-3 pt-3 border-t border-gray-300 text-xs text-gray-500">
                                  <p className="font-medium mb-1">Referências:</p>
                                  <div className="flex flex-wrap gap-2">
                                    {message.citations.map((citation) => (
                                      <span key={citation.document_id + citation.label} className="px-2 py-1 bg-gray-200 rounded">
                                        {citation.label}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {autoReview && !message.pending && (
                                <div className="mt-3 rounded-2xl border border-amber-200 bg-white/80 p-3 text-xs text-gray-700">
                                  <div className="flex items-center justify-between font-semibold uppercase tracking-wide text-[11px]">
                                    <span>Revisão automática</span>
                                    <span className={autoReview.verdict === 'ok' ? 'text-emerald-600' : 'text-amber-700'}>
                                      {autoReview.verdict === 'ok' ? 'Sem alertas' : 'Rever pontos'}
                                    </span>
                                  </div>
                                  {autoReview.summary && <p className="mt-2 text-gray-700">{autoReview.summary}</p>}
                                  {autoReview.missingInformation.length > 0 && (
                                    <div className="mt-2">
                                      <p className="font-medium text-gray-800">Lacunas:</p>
                                      <ul className="mt-1 list-disc pl-5 space-y-0.5">
                                        {autoReview.missingInformation.map((item) => (
                                          <li key={item}>{item}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  {autoReview.requiredCitations.length > 0 && (
                                    <div className="mt-2">
                                      <p className="font-medium text-gray-800">Citações obrigatórias:</p>
                                      <ul className="mt-1 list-disc pl-5 space-y-0.5">
                                        {autoReview.requiredCitations.map((item) => (
                                          <li key={item}>{item}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                  {autoReview.numericAlerts.length > 0 && (
                                    <div className="mt-2">
                                      <p className="font-medium text-gray-800">Números para conferir:</p>
                                      <ul className="mt-1 list-disc pl-5 space-y-0.5">
                                        {autoReview.numericAlerts.map((item) => (
                                          <li key={item}>{item}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                              {coverage && !message.pending && (
                                <p className="mt-3 text-[11px] uppercase tracking-wide text-gray-500">
                                  Cobertura automática: {coverage.retrieved} de {coverage.total ?? '?'} documentos por similaridade • {coverage.forced}{' '}
                                  complementares forçados
                                </p>
                              )}
                              {message.role === 'assistant' && !message.pending && (
                                <div className="mt-4 rounded-2xl border border-gray-200 bg-white/80 p-3 text-xs text-gray-700">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-gray-900">Como foi esta resposta?</span>
                                    {([
                                      { value: 'useful', label: 'Útil' },
                                      { value: 'incomplete', label: 'Incompleta' },
                                      { value: 'incorrect', label: 'Incorreta' }
                                    ] as { value: FeedbackRating; label: string }[]).map((option) => (
                                      <button
                                        key={option.value}
                                        type="button"
                                        onClick={() => handleFeedbackChoice(message.id, option.value)}
                                        className={`rounded-full border px-3 py-1 transition text-xs ${
                                          draft.rating === option.value
                                            ? 'bg-gray-900 text-white border-gray-900'
                                            : 'border-gray-300 text-gray-600 hover:border-gray-400'
                                        }`}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                  {draft.rating && (
                                    <div className="mt-3 space-y-2">
                                      <textarea
                                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:border-gray-500 focus:outline-none"
                                        placeholder="Explique o que faltou (opcional)"
                                        value={draft.notes}
                                        onChange={(event) => handleFeedbackFieldChange(message.id, 'notes', event.target.value)}
                                      />
                                      <textarea
                                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs focus:border-gray-500 focus:outline-none"
                                        placeholder="Cole uma versão corrigida para reaproveitarmos (opcional)"
                                        value={draft.revisedAnswer}
                                        onChange={(event) => handleFeedbackFieldChange(message.id, 'revisedAnswer', event.target.value)}
                                      />
                                      <div className="flex items-center gap-3">
                                        <button
                                          type="button"
                                          onClick={() => handleSubmitFeedback(message.id)}
                                          disabled={draft.status === 'saving'}
                                          className="rounded-full bg-gray-900 px-4 py-1 text-white text-xs font-semibold disabled:opacity-50"
                                        >
                                          {draft.status === 'saving' ? 'Enviando...' : 'Enviar feedback'}
                                        </button>
                                        {draft.status === 'sent' && <span className="text-emerald-600">Enviado ✓</span>}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          {message.role === 'user' && (
                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-900 flex items-center justify-center text-xs font-semibold text-white order-3">
                              V
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
            </div>

              {/* Input de mensagem */}
              <div className="flex-shrink-0 border-t border-gray-200 bg-white p-4">
                <form 
                  className="max-w-3xl mx-auto flex gap-3" 
                  onSubmit={handleSendMessage}
                >
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                    placeholder="Mensagem..."
                    className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
                    disabled={!selectedChatId || sendingMessage}
              />
              <button
                type="submit"
                    disabled={!selectedChatId || sendingMessage || !chatInput.trim()}
                    className="rounded-lg bg-gray-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {sendingMessage ? 'Enviando...' : 'Enviar'}
              </button>
            </form>
          </div>
            </div>
          </div>
        </main>

        {/* Sidebar Direita - Documentos (ocultável) */}
        {showDocumentsPanel && (
          <aside className="flex-shrink-0 w-80 border-l border-gray-200 bg-white overflow-y-auto">
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900">Documentos</h2>
                <button
                  type="button"
                  onClick={() => setShowDocumentsPanel(false)}
                  className="text-xs text-gray-500 hover:text-gray-700"
                  title="Ocultar"
                >
                  ×
                </button>
              </div>

              {/* Upload de documentos */}
              <div className="mb-6 p-4 border border-gray-200 rounded-lg bg-gray-50">
                <h3 className="text-xs font-semibold text-gray-900 mb-3">Upload</h3>
                <form onSubmit={handleUpload} className="space-y-3">
                  <input
                    type="text"
                    name="title"
                    placeholder="Título (opcional)"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:border-gray-400 focus:outline-none"
                  />
                  <input
                    type="file"
                    name="files"
                    accept="application/pdf,image/png,image/jpeg"
                    className="w-full text-xs"
                    multiple
                    required
                  />
                  <button
                    type="submit"
                    disabled={uploading}
                    className="w-full rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {uploading ? 'Processando...' : 'Enviar'}
                  </button>
                </form>
              </div>

              {/* Lista de documentos */}
              <div className="space-y-2">
                {documents.map((document) => (
                  <article 
                    key={document.id} 
                    className="rounded-lg border border-gray-200 p-3 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">
                          {document.title ?? document.original_filename}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {new Date(document.created_at).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(document.status)}`}>
                          {statusLabel(document.status)}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeleteDocument(document.id)}
                          disabled={deletingDocumentId === document.id}
                          className="text-xs text-gray-400 hover:text-red-600 disabled:opacity-50"
                          title="Excluir"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    {document.summary && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => toggleDocumentSummary(document.id)}
                          className="text-xs text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1 w-full text-left"
                        >
                          <span>{expandedSummaries[document.id] ? '▼' : '▶'}</span>
                          <span>Resumo</span>
                        </button>
                        {expandedSummaries[document.id] && (
                          <p className="mt-2 text-xs text-gray-600 leading-relaxed pl-4">
                            {document.summary}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
                {!documents.length && (
                  <p className="text-xs text-gray-500 text-center py-4">Nenhum documento ainda</p>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* Botão para mostrar sidebar de documentos quando oculta */}
        {!showDocumentsPanel && (
          <button
            type="button"
            onClick={() => setShowDocumentsPanel(true)}
            className="fixed right-4 top-1/2 -translate-y-1/2 bg-gray-900 text-white rounded-l-lg px-2 py-4 text-xs hover:bg-gray-800 transition-colors z-10"
            title="Mostrar documentos"
          >
            Doc
          </button>
        )}
      </div>
    </div>
  );
}

function statusBadge(status: DocumentRecord['status']) {
  switch (status) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-700';
    case 'processing':
      return 'bg-amber-100 text-amber-700';
    case 'error':
      return 'bg-rose-100 text-rose-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function statusLabel(status: DocumentRecord['status']) {
  switch (status) {
    case 'ready':
      return 'Pronto';
    case 'processing':
      return 'Processando';
    case 'error':
      return 'Erro';
    default:
      return 'Pendente';
  }
}

const markdownComponents = {
  p: (props: ComponentPropsWithoutRef<'p'>) => <p className="my-2 leading-relaxed whitespace-pre-wrap" {...props} />,
  ul: (props: ComponentPropsWithoutRef<'ul'>) => <ul className="my-2 list-disc pl-6 space-y-1" {...props} />,
  ol: (props: ComponentPropsWithoutRef<'ol'>) => <ol className="my-2 list-decimal pl-6 space-y-1" {...props} />,
  li: (props: ComponentPropsWithoutRef<'li'>) => <li className="mb-1" {...props} />,
  strong: (props: ComponentPropsWithoutRef<'strong'>) => <strong className="font-semibold" {...props} />,
  h1: (props: ComponentPropsWithoutRef<'h1'>) => <h1 className="mt-4 mb-2 text-lg font-semibold" {...props} />,
  h2: (props: ComponentPropsWithoutRef<'h2'>) => <h2 className="mt-4 mb-2 text-base font-semibold" {...props} />,
  h3: (props: ComponentPropsWithoutRef<'h3'>) => <h3 className="mt-4 mb-2 text-sm font-semibold" {...props} />,
  code: (props: ComponentPropsWithoutRef<'code'>) => (
    <code className="bg-gray-200 px-1.5 py-0.5 rounded text-xs font-mono" {...props} />
  ),
  pre: (props: ComponentPropsWithoutRef<'pre'>) => (
    <pre className="bg-gray-200 p-3 rounded-lg overflow-x-auto my-2 text-xs" {...props} />
  )
};

function formatMessageContent(content: string) {
  if (!content) return '';
  return content.replace(/\n{2,}/g, '\n\n').trim();
}

type AutoReviewDisplay = {
  verdict: 'ok' | 'needs_review';
  summary: string;
  missingInformation: string[];
  requiredCitations: string[];
  numericAlerts: string[];
};

function resolveAutoReview(metadata: Record<string, unknown> | null): AutoReviewDisplay | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { auto_review?: unknown }).auto_review;
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  return {
    verdict: payload.verdict === 'needs_review' ? 'needs_review' : 'ok',
    summary: typeof payload.summary === 'string' ? payload.summary : '',
    missingInformation: coerceStringArray(payload.missingInformation ?? payload.missing_information),
    requiredCitations: coerceStringArray(payload.requiredCitations ?? payload.required_citations),
    numericAlerts: coerceStringArray(payload.numericAlerts ?? payload.numeric_alerts)
  };
}

function resolveCoverage(metadata: Record<string, unknown> | null) {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { coverage?: unknown }).coverage;
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  const total = typeof payload.totalDocuments === 'number' ? payload.totalDocuments : null;
  const retrieved = Array.isArray(payload.retrievedDocuments) ? payload.retrievedDocuments.length : 0;
  const forced = Array.isArray(payload.forcedDocuments) ? payload.forcedDocuments.length : 0;
  return { total, retrieved, forced };
}

function coerceStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}

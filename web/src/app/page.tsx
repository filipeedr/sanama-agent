'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type ComponentPropsWithoutRef, type FormEvent, useCallback, useEffect, useState } from 'react';

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
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, FeedbackDraft>>({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const emptyDraft: FeedbackDraft = { rating: null, notes: '', revisedAnswer: '', status: 'idle' };

  // Determina se estamos na view de chat ou na página inicial
  const isChatView = selectedNotebookId !== null;

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
  }, []);

  const loadChats = useCallback(async () => {
    if (!selectedNotebookId) return;
    const response = await fetch('/api/chats', { cache: 'no-store' });
    if (!response.ok) {
      setStatusMessage('Erro ao carregar chats');
      return;
    }
    const payload = await response.json();
    const allChats = payload.data ?? [];
    const filtered = allChats.filter((chat: ChatRecord) => chat.notebook_id === selectedNotebookId);
    setChats(filtered);
  }, [selectedNotebookId]);

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
  }, [loadDocuments, loadNotebooks]);

  useEffect(() => {
    if (selectedNotebookId) {
      loadChats();
    }
  }, [selectedNotebookId, loadChats]);

  useEffect(() => {
    if (selectedNotebookId && chats.length > 0 && !selectedChatId) {
      setSelectedChatId(chats[0].id);
    }
  }, [selectedNotebookId, chats, selectedChatId]);

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
      setShowCreateModal(false);
      await loadNotebooks();
      setStatusMessage('Agente criado com sucesso');
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

  const handleCreateChat = async (notebookId: string) => {
    try {
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
        setStatusMessage('Chat criado');
      }
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
      setStatusMessage('Agente removido');
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

  const handleNotebookClick = (notebookId: string) => {
    setSelectedNotebookId(notebookId);
    setSelectedChatId(null);
    setMessages([]);
  };

  const handleBackToHome = () => {
    setSelectedNotebookId(null);
    setSelectedChatId(null);
    setMessages([]);
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

  const selectedNotebook = notebooks.find((n) => n.id === selectedNotebookId);

  // Página inicial: lista de agentes
  if (!isChatView) {
    return (
      <div className="flex h-screen w-full bg-gradient-to-br from-slate-50 via-white to-slate-50">
        {/* Sidebar de Documentos */}
        <aside className="flex-shrink-0 w-80 border-r border-slate-200/60 bg-white/80 backdrop-blur-sm overflow-y-auto">
          <div className="p-6">
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-slate-900 mb-1">Documentos</h2>
              <p className="text-xs text-slate-500">Gerencie seus documentos</p>
            </div>

            {/* Upload de documentos */}
            <div className="mb-6 p-4 border border-slate-200 rounded-xl bg-gradient-to-br from-slate-50 to-white shadow-sm hover:shadow-md transition-all duration-300">
              <h3 className="text-xs font-semibold text-slate-900 mb-3">Upload</h3>
              <form onSubmit={handleUpload} className="space-y-3">
                <input
                  type="text"
                  name="title"
                  placeholder="Título (opcional)"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200"
                />
                <input
                  type="file"
                  name="files"
                  accept="application/pdf,image/png,image/jpeg"
                  className="w-full text-xs file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-900 file:text-white hover:file:bg-slate-800 file:transition-colors file:duration-200 cursor-pointer"
                  multiple
                  required
                />
                <button
                  type="submit"
                  disabled={uploading}
                  className="w-full rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
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
                  className="rounded-xl border border-slate-200 p-3 hover:bg-slate-50 hover:border-slate-300 hover:shadow-sm transition-all duration-200 group"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-900 truncate group-hover:text-slate-700 transition-colors">
                        {document.title ?? document.original_filename}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {new Date(document.created_at).toLocaleDateString('pt-BR')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${statusBadge(document.status)}`}>
                        {statusLabel(document.status)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteDocument(document.id)}
                        disabled={deletingDocumentId === document.id}
                        className="text-xs text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors duration-200 opacity-0 group-hover:opacity-100"
                        title="Excluir"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </article>
              ))}
              {!documents.length && (
                <p className="text-xs text-slate-500 text-center py-8">Nenhum documento ainda</p>
              )}
            </div>
          </div>
        </aside>

        {/* Área Central - Lista de Agentes */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-8 py-12">
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-slate-900 mb-2">Agentes de Consulta</h1>
              <p className="text-slate-600">Selecione um agente para começar a conversar</p>
            </div>

            {/* Grid de Agentes */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {notebooks.map((notebook) => (
                <div
                  key={notebook.id}
                  onClick={() => handleNotebookClick(notebook.id)}
                  className="group relative rounded-2xl border border-slate-200 bg-white p-6 hover:border-slate-300 hover:shadow-lg transition-all duration-300 cursor-pointer hover:-translate-y-1"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base font-semibold text-slate-900 mb-1 group-hover:text-slate-700 transition-colors">
                        {notebook.name}
                      </h3>
                      {notebook.description && (
                        <p className="text-sm text-slate-600 line-clamp-2">{notebook.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteNotebook(notebook.id);
                      }}
                      disabled={deletingNotebookId === notebook.id}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors duration-200 opacity-0 group-hover:opacity-100 ml-2"
                      title="Excluir"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex items-center text-xs text-slate-500 mt-4">
                    <span>Criado em {new Date(notebook.created_at).toLocaleDateString('pt-BR')}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Botão Criar Agente */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-medium text-white hover:bg-slate-800 transition-all duration-200 hover:shadow-lg active:scale-[0.98]"
              >
                + Criar agente
              </button>
            </div>

            {!notebooks.length && (
              <div className="text-center py-16">
                <p className="text-slate-500 mb-4">Nenhum agente criado ainda</p>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  className="rounded-xl bg-slate-900 px-6 py-3 text-sm font-medium text-white hover:bg-slate-800 transition-all duration-200 hover:shadow-lg active:scale-[0.98]"
                >
                  Criar primeiro agente
                </button>
              </div>
            )}
          </div>
        </main>

        {/* Modal de Criação de Agente */}
        {showCreateModal && (
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={() => setShowCreateModal(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in zoom-in-95 duration-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-6">
                <h2 className="text-xl font-semibold text-slate-900 mb-1">Criar novo agente</h2>
                <p className="text-sm text-slate-600">Configure seu agente de consulta</p>
              </div>

              <form onSubmit={handleNotebookSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-900 mb-1.5">Nome do agente</label>
                  <input
                    type="text"
                    placeholder="Ex: Assistente de Vendas"
                    value={notebookForm.name}
                    onChange={(event) => setNotebookForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-4 py-2.5 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-900 mb-1.5">Descrição (opcional)</label>
                  <textarea
                    placeholder="Descreva o propósito deste agente..."
                    value={notebookForm.description}
                    onChange={(event) => setNotebookForm((prev) => ({ ...prev, description: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-4 py-2.5 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200 resize-none"
                    rows={3}
                  />
                </div>

                {documents.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-slate-900 mb-1.5">Documentos</label>
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3 bg-slate-50">
                      {documents.map((document) => (
                        <label
                          key={document.id}
                          className="flex items-center gap-2 text-sm cursor-pointer hover:bg-white p-2 rounded-lg transition-colors duration-200"
                        >
                          <input
                            type="checkbox"
                            checked={notebookForm.documentIds.includes(document.id)}
                            onChange={() => handleDocumentSelection(document.id)}
                            className="rounded border-slate-300 text-slate-900 focus:ring-slate-200"
                          />
                          <span className="text-slate-700 truncate">{document.title ?? document.original_filename}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      setNotebookForm({ name: '', description: '', documentIds: [] });
                    }}
                    className="flex-1 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-all duration-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={creatingNotebook}
                    className="flex-1 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 active:scale-[0.98]"
                  >
                    {creatingNotebook ? 'Criando...' : 'Criar agente'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Status Message */}
        {statusMessage && (
          <div className="fixed bottom-4 right-4 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-lg text-sm animate-in slide-in-from-bottom-4 duration-200 z-50">
            {statusMessage}
          </div>
        )}
      </div>
    );
  }

  // View de Chat
  return (
    <div className="flex h-screen w-full flex-col bg-gradient-to-br from-slate-50 via-white to-slate-50">
      {/* Navbar */}
      <nav className="flex-shrink-0 border-b border-slate-200/60 bg-white/80 backdrop-blur-sm px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleBackToHome}
              className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors duration-200 group"
            >
              <svg
                className="w-5 h-5 group-hover:-translate-x-1 transition-transform duration-200"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              <span className="text-sm font-medium">Voltar</span>
            </button>
            <div className="h-6 w-px bg-slate-200" />
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{selectedNotebook?.name ?? 'Agente'}</h1>
              {selectedNotebook?.description && (
                <p className="text-xs text-slate-500 mt-0.5">{selectedNotebook.description}</p>
              )}
            </div>
          </div>
          {statusMessage && (
            <span className="rounded-full bg-slate-900 px-3 py-1 text-xs text-white animate-in fade-in duration-200">
              {statusMessage}
            </span>
          )}
        </div>
      </nav>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar de Conversas */}
        <aside className="flex-shrink-0 w-64 border-r border-slate-200/60 bg-white/80 backdrop-blur-sm overflow-y-auto">
          <div className="p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-slate-900">Conversas</h2>
              <button
                type="button"
                onClick={() => handleCreateChat(selectedNotebookId!)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                title="Nova conversa"
              >
                + Novo
              </button>
            </div>
            <div className="space-y-1">
              {chats.map((chat) => (
                <div
                  key={chat.id}
                  className={`group rounded-lg px-3 py-2 text-sm cursor-pointer transition-all duration-200 ${
                    chat.id === selectedChatId
                      ? 'bg-slate-100 text-slate-900 shadow-sm'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedChatId(chat.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{chat.title ?? 'Chat sem título'}</p>
                      {chat.last_message_at && (
                        <p className="text-xs text-slate-500 mt-0.5">
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
                      className="text-xs text-slate-400 hover:text-red-600 disabled:opacity-50 transition-colors duration-200 flex-shrink-0 opacity-0 group-hover:opacity-100"
                      title="Excluir"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
              {!chats.length && (
                <p className="text-xs text-slate-500 text-center py-4">Crie um chat para começar</p>
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
                    <h3 className="text-lg font-semibold text-slate-900 mb-2">Como posso ajudar?</h3>
                    <p className="text-sm text-slate-500">Faça uma pergunta sobre seus documentos</p>
                  </div>
                </div>
              ) : (
                messages.map((message) => {
                  const draft = getFeedbackDraft(message.id);
                  return (
                    <div
                      key={message.id}
                      className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                    >
                      {message.role === 'assistant' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-sm font-semibold text-slate-700 shadow-sm">
                          AI
                        </div>
                      )}
                      <div className={`flex-1 max-w-[85%] ${message.role === 'user' ? 'order-2' : ''}`}>
                        <div
                          className={`rounded-2xl px-4 py-3 shadow-sm transition-all duration-200 ${
                            message.role === 'user'
                              ? 'bg-slate-900 text-white'
                              : 'bg-slate-100 text-slate-900 border border-slate-200/60'
                          }`}
                        >
                          {message.pending && message.role === 'assistant' ? (
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-slate-400"></span>
                              <span className="text-sm">Pensando...</span>
                            </div>
                          ) : (
                            <div className={`text-sm leading-relaxed ${message.pending ? 'opacity-70' : ''}`}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                {formatMessageContent(message.content)}
                              </ReactMarkdown>
                            </div>
                          )}
                          {message.role === 'assistant' && !message.pending && (
                            <div className="mt-4 rounded-2xl border border-slate-200 bg-white/80 p-3 text-xs text-slate-700">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-slate-900">Como foi esta resposta?</span>
                                {([
                                  { value: 'useful', label: 'Útil' },
                                  { value: 'incomplete', label: 'Incompleta' },
                                  { value: 'incorrect', label: 'Incorreta' }
                                ] as { value: FeedbackRating; label: string }[]).map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => handleFeedbackChoice(message.id, option.value)}
                                    className={`rounded-full border px-3 py-1 transition-all duration-200 text-xs ${
                                      draft.rating === option.value
                                        ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                                        : 'border-slate-300 text-slate-600 hover:border-slate-400 hover:bg-slate-50'
                                    }`}
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                              {draft.rating && (
                                <div className="mt-3 space-y-2">
                                  <textarea
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200"
                                    placeholder="Explique o que faltou (opcional)"
                                    value={draft.notes}
                                    onChange={(event) => handleFeedbackFieldChange(message.id, 'notes', event.target.value)}
                                  />
                                  <textarea
                                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200"
                                    placeholder="Cole uma versão corrigida para reaproveitarmos (opcional)"
                                    value={draft.revisedAnswer}
                                    onChange={(event) =>
                                      handleFeedbackFieldChange(message.id, 'revisedAnswer', event.target.value)
                                    }
                                  />
                                  <div className="flex items-center gap-3">
                                    <button
                                      type="button"
                                      onClick={() => handleSubmitFeedback(message.id)}
                                      disabled={draft.status === 'saving'}
                                      className="rounded-full bg-slate-900 px-4 py-1 text-white text-xs font-semibold disabled:opacity-50 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                                    >
                                      {draft.status === 'saving' ? 'Enviando...' : 'Enviar feedback'}
                                    </button>
                                    {draft.status === 'sent' && (
                                      <span className="text-emerald-600 animate-in fade-in duration-200">Enviado ✓</span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      {message.role === 'user' && (
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-xs font-semibold text-white shadow-sm order-3">
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
          <div className="flex-shrink-0 border-t border-slate-200/60 bg-white/80 backdrop-blur-sm p-4">
            <form className="max-w-3xl mx-auto flex gap-3" onSubmit={handleSendMessage}>
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Mensagem..."
                className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200/50 transition-all duration-200"
                disabled={!selectedChatId || sendingMessage}
              />
              <button
                type="submit"
                disabled={!selectedChatId || sendingMessage || !chatInput.trim()}
                className="rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
              >
                {sendingMessage ? 'Enviando...' : 'Enviar'}
              </button>
            </form>
          </div>
        </div>
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
    <code className="bg-slate-200 px-1.5 py-0.5 rounded text-xs font-mono" {...props} />
  ),
  pre: (props: ComponentPropsWithoutRef<'pre'>) => (
    <pre className="bg-slate-200 p-3 rounded-lg overflow-x-auto my-2 text-xs" {...props} />
  )
};

function formatMessageContent(content: string) {
  if (!content) return '';
  return content.replace(/\n{2,}/g, '\n\n').trim();
}

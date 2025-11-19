'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type ComponentPropsWithoutRef, type FormEvent, useCallback, useEffect, useState, useRef } from 'react';

if (typeof window !== 'undefined') {
  if (typeof (window as any).requestIdleCallback !== 'function') {
    (window as any).requestIdleCallback = (callback: IdleRequestCallback): number => {
      const start = Date.now();
      return window.setTimeout(() => {
        callback({
          didTimeout: false,
          timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
        });
      }, 1);
    };
  }

  if (typeof (window as any).cancelIdleCallback !== 'function') {
    (window as any).cancelIdleCallback = (id: number) => {
      window.clearTimeout(id);
    };
  }
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
  const [isDragging, setIsDragging] = useState(false);
  const [dragFiles, setDragFiles] = useState<File[]>([]);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [editingNotebookId, setEditingNotebookId] = useState<string | null>(null);
  const [editingNotebookName, setEditingNotebookName] = useState('');
  const [updatingNotebookId, setUpdatingNotebookId] = useState<string | null>(null);
  const [typingMessages, setTypingMessages] = useState<Record<string, string>>({});
  const typingTimeoutsRef = useRef<Record<string, NodeJS.Timeout>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const emptyDraft: FeedbackDraft = { rating: null, notes: '', revisedAnswer: '', status: 'idle' };
  
  const MAX_DOCUMENTS = 50;
  const currentDocumentCount = documents.length;
  const remainingSlots = Math.max(0, MAX_DOCUMENTS - currentDocumentCount);
  const isAtLimit = currentDocumentCount >= MAX_DOCUMENTS;

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

  const startTypingEffect = useCallback((messageId: string, fullText: string) => {
    // Limpa timeout anterior se existir
    if (typingTimeoutsRef.current[messageId]) {
      clearTimeout(typingTimeoutsRef.current[messageId]);
    }
    
    setTypingMessages(prev => ({ ...prev, [messageId]: '' }));
    let currentIndex = 0;
    const charsPerChunk = 3; // Múltiplos caracteres por vez para ser rápido
    
    const typeNext = () => {
      if (currentIndex < fullText.length) {
        const nextIndex = Math.min(currentIndex + charsPerChunk, fullText.length);
        setTypingMessages(prev => ({ ...prev, [messageId]: fullText.slice(0, nextIndex) }));
        currentIndex = nextIndex;
        typingTimeoutsRef.current[messageId] = setTimeout(typeNext, 15); // 15ms = rápido mas visível
      } else {
        // Remove da lista quando terminar
        setTimeout(() => {
          setTypingMessages(prev => {
            const newState = { ...prev };
            delete newState[messageId];
            return newState;
          });
        }, 100);
      }
    };
    
    typeNext();
  }, []);

  const loadMessages = useCallback(
    async (chatId: string, skipTypingEffect = false) => {
      const response = await fetch(`/api/chats/${chatId}/messages`, { cache: 'no-store' });
      if (!response.ok) {
        setStatusMessage('Erro ao carregar mensagens');
        return;
      }
      const payload = await response.json();
      const loadedMessages = (payload.data ?? []).map((message: ChatMessageRecord) => ({ ...message, pending: false }));
      setMessages(loadedMessages);
      
      // Só inicia efeito de digitação se for uma nova mensagem (não ao carregar mensagens antigas)
      if (!skipTypingEffect) {
        const lastMessage = loadedMessages[loadedMessages.length - 1];
        if (lastMessage && lastMessage.role === 'assistant' && !lastMessage.pending) {
          // Pequeno delay para garantir que o estado foi atualizado
          setTimeout(() => {
            startTypingEffect(lastMessage.id, lastMessage.content);
          }, 100);
        }
      }
    },
    [startTypingEffect]
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
      // Ao entrar no chat, carrega mensagens sem animação de digitação
      loadMessages(selectedChatId, true);
    } else {
      setMessages([]);
    }
  }, [selectedChatId, loadMessages]);

  // Scroll automático para o final quando novas mensagens são adicionadas
  useEffect(() => {
    if (messagesEndRef.current && messagesContainerRef.current) {
      const container = messagesContainerRef.current;
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 200;
      
      // Faz scroll se o usuário estiver perto do final ou se for uma nova mensagem
      if (isNearBottom || messages.length <= 1) {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      }
    }
  }, [messages.length]);

  useEffect(() => {
    setFeedbackDrafts({});
    // Limpa timeouts ao mudar de chat
    Object.values(typingTimeoutsRef.current).forEach(timeout => clearTimeout(timeout));
    typingTimeoutsRef.current = {};
    setTypingMessages({});
  }, [selectedChatId]);

  const handleUpload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const formData = new FormData();
    
    const currentCount = documents.length;
    
    // Verifica o limite antes de processar
    if (currentCount >= MAX_DOCUMENTS) {
      setStatusMessage(`Limite de ${MAX_DOCUMENTS} documentos atingido. Exclua documentos antes de adicionar novos.`);
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
    
    // Usa arquivos do drag & drop se disponíveis, senão usa do formulário
    let collectedFiles: File[] = [];
    if (dragFiles.length > 0) {
      collectedFiles = dragFiles;
      dragFiles.forEach((file) => {
        formData.append('files', file);
      });
    } else {
      const originalFormData = new FormData(formElement);
      const formFiles = originalFormData
        .getAll('files')
        .filter((entry): entry is File => entry instanceof File);
      const fallback = originalFormData.get('file');
      if (fallback instanceof File && !formFiles.length) {
        formFiles.push(fallback);
      }
      collectedFiles = formFiles;
      formFiles.forEach((file) => {
        formData.append('files', file);
      });
    }
    
    if (!collectedFiles.length) {
      setStatusMessage('Selecione pelo menos um arquivo');
      return;
    }
    
    // Verifica se o número de arquivos excede o limite disponível
    if (currentCount + collectedFiles.length > MAX_DOCUMENTS) {
      const allowedCount = MAX_DOCUMENTS - currentCount;
      setStatusMessage(`Você pode enviar apenas mais ${allowedCount} documento(s). Limite de ${MAX_DOCUMENTS} documentos.`);
      setTimeout(() => setStatusMessage(null), 4000);
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
      setDragFiles([]);
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setUploading(false);
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (documents.length < MAX_DOCUMENTS) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const currentCount = documents.length;

    if (currentCount >= MAX_DOCUMENTS) {
      setStatusMessage(`Limite de ${MAX_DOCUMENTS} documentos atingido. Exclua documentos antes de adicionar novos.`);
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }

    const files = Array.from(event.dataTransfer.files).filter((file) => {
      const validTypes = ['application/pdf', 'image/png', 'image/jpeg'];
      return validTypes.includes(file.type);
    });

    if (files.length > 0) {
      // Verifica se o número de arquivos excede o limite disponível
      if (currentCount + files.length > MAX_DOCUMENTS) {
        const allowedCount = MAX_DOCUMENTS - currentCount;
        setStatusMessage(`Você pode enviar apenas mais ${allowedCount} documento(s). Limite de ${MAX_DOCUMENTS} documentos.`);
        setTimeout(() => setStatusMessage(null), 4000);
        return;
      }
      setDragFiles(files);
    } else {
      setStatusMessage('Apenas arquivos PDF, PNG ou JPEG são permitidos');
      setTimeout(() => setStatusMessage(null), 4000);
    }
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      const currentCount = documents.length;
      
      if (currentCount >= MAX_DOCUMENTS) {
        setStatusMessage(`Limite de ${MAX_DOCUMENTS} documentos atingido. Exclua documentos antes de adicionar novos.`);
        setTimeout(() => setStatusMessage(null), 4000);
        event.target.value = '';
        return;
      }

      const files = Array.from(event.target.files).filter((file) => {
        const validTypes = ['application/pdf', 'image/png', 'image/jpeg'];
        return validTypes.includes(file.type);
      });
      
      if (files.length > 0) {
        // Verifica se o número de arquivos excede o limite disponível
        if (currentCount + files.length > MAX_DOCUMENTS) {
          const allowedCount = MAX_DOCUMENTS - currentCount;
          setStatusMessage(`Você pode enviar apenas mais ${allowedCount} documento(s). Limite de ${MAX_DOCUMENTS} documentos.`);
          setTimeout(() => setStatusMessage(null), 4000);
          event.target.value = '';
          return;
        }
        setDragFiles(files);
      } else {
        setStatusMessage('Apenas arquivos PDF, PNG ou JPEG são permitidos');
        setTimeout(() => setStatusMessage(null), 4000);
      }
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
    setOpenDropdownId(null);
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

  const handleEditNotebook = (notebook: NotebookRecord) => {
    setEditingNotebookId(notebook.id);
    setEditingNotebookName(notebook.name);
    setOpenDropdownId(null);
  };

  const handleCancelEdit = () => {
    setEditingNotebookId(null);
    setEditingNotebookName('');
  };

  const handleSaveNotebookName = async (notebookId: string) => {
    if (!editingNotebookName.trim() || editingNotebookName.trim().length < 3) {
      setStatusMessage('O nome deve ter pelo menos 3 caracteres');
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
    
    setUpdatingNotebookId(notebookId);
    try {
      const response = await fetch('/api/notebooks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: notebookId, name: editingNotebookName.trim() })
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? 'Erro ao atualizar notebook');
      }
      await loadNotebooks();
      setEditingNotebookId(null);
      setEditingNotebookName('');
      setStatusMessage('Nome do agente atualizado');
    } catch (error) {
      setStatusMessage((error as Error).message);
    } finally {
      setUpdatingNotebookId(null);
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
    if (!messageContent || messageContent.length < 3) {
      setStatusMessage('A mensagem deve ter pelo menos 3 caracteres');
      setTimeout(() => setStatusMessage(null), 4000);
      return;
    }
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
    
    // Scroll imediato quando o usuário envia mensagem
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
    try {
      const response = await fetch(`/api/chats/${selectedChatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: messageContent })
      });
      if (!response.ok) {
        const payload = await response.json();
        const errorMessage = typeof payload.error === 'object' && payload.error?.content
          ? payload.error.content[0] ?? 'Erro ao enviar mensagem'
          : payload.error ?? 'Erro ao enviar mensagem';
        throw new Error(errorMessage);
      }
      // Carrega mensagens com animação de digitação para a nova resposta da IA
      await loadMessages(selectedChatId, false);
      await loadChats();
      
      // Força scroll para baixo após enviar mensagem
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 300);
      
      // Reset textarea height after sending
      const textarea = document.querySelector('textarea[placeholder="Tire dúvidas sobre o documento..."]') as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.height = 'auto';
      }
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
        <aside className="flex-shrink-0 w-80 border-r border-slate-200/60 bg-white/80 backdrop-blur-sm flex flex-col h-screen">
          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              <div className="mb-6">
                <h2 className="text-sm font-semibold text-slate-900 mb-1">Documentos</h2>
              </div>

              {/* Upload de documentos */}
              <div className="mb-6 p-4 border border-slate-200 rounded-xl bg-gradient-to-br from-slate-50 to-white shadow-sm hover:shadow-md transition-all duration-300">
              <form onSubmit={handleUpload} className="space-y-3">
                <div
                  onDragEnter={handleDragEnter}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-all duration-200 ${
                    isAtLimit
                      ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
                      : isDragging
                      ? 'border-slate-900 bg-slate-100'
                      : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="file"
                    name="files"
                    id="file-upload"
                    accept="application/pdf,image/png,image/jpeg"
                    className="absolute inset-0 w-full h-full opacity-0 z-10"
                    multiple
                    onChange={handleFileInputChange}
                    disabled={isAtLimit}
                    style={{ cursor: isAtLimit ? 'not-allowed' : 'pointer' }}
                  />
                  <div className="relative z-0">
                    <svg
                      className="mx-auto h-8 w-8 text-slate-400 mb-2 pointer-events-none"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                    <p className="text-xs text-slate-600 mb-1 pointer-events-none">
                      {isAtLimit
                        ? `Limite de ${MAX_DOCUMENTS} documentos atingido`
                        : isDragging
                        ? 'Solte os arquivos aqui'
                        : dragFiles.length > 0
                        ? `${dragFiles.length} arquivo(s) selecionado(s)`
                        : 'Arraste arquivos aqui ou clique para selecionar'}
                    </p>
                    <p className="text-xs text-slate-400 pointer-events-none">PDF, PNG ou JPEG</p>
                    {dragFiles.length > 0 && (
                      <div className="mt-3 space-y-1 pointer-events-none">
                        {dragFiles.map((file, index) => (
                          <p key={index} className="text-xs text-slate-700 truncate">
                            {file.name}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={uploading || dragFiles.length === 0 || isAtLimit}
                  className="w-full rounded-lg px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                  style={{ backgroundColor: '#085E83' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
                >
                  {uploading ? 'Processando...' : isAtLimit ? 'Limite atingido' : 'Enviar'}
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
                      {document.status !== 'ready' && (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium transition-colors ${statusBadge(document.status)}`}>
                          {statusLabel(document.status)}
                        </span>
                      )}
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
          </div>

          {/* Rodapé fixo com barra de progresso do limite */}
          <div className="flex-shrink-0 border-t border-slate-200 bg-white/80 backdrop-blur-sm p-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">Limite de documentos</span>
              <span className={`text-xs font-semibold ${isAtLimit ? 'text-rose-600' : 'text-slate-600'}`}>
                {currentDocumentCount}/{MAX_DOCUMENTS}
              </span>
            </div>
            <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isAtLimit
                    ? 'bg-rose-500'
                    : currentDocumentCount >= MAX_DOCUMENTS * 0.8
                    ? 'bg-amber-500'
                    : 'bg-slate-900'
                }`}
                style={{ width: `${Math.min(100, (currentDocumentCount / MAX_DOCUMENTS) * 100)}%` }}
              />
            </div>
            {isAtLimit && (
              <p className="text-xs text-rose-600 mt-2 text-center">
                Exclua documentos para liberar espaço
              </p>
            )}
            {!isAtLimit && remainingSlots <= 10 && (
              <p className="text-xs text-amber-600 mt-2 text-center">
                Restam {remainingSlots} vaga(s)
              </p>
            )}
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
                  className="group relative rounded-2xl border border-slate-200 bg-white p-6 hover:border-slate-300 hover:shadow-lg transition-all duration-300 hover:-translate-y-1"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div 
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => handleNotebookClick(notebook.id)}
                    >
                      {editingNotebookId === notebook.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editingNotebookName}
                            onChange={(e) => setEditingNotebookName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                handleSaveNotebookName(notebook.id);
                              } else if (e.key === 'Escape') {
                                handleCancelEdit();
                              }
                            }}
                            className="text-base font-semibold text-slate-900 border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-slate-400 w-full"
                            autoFocus
                            disabled={updatingNotebookId === notebook.id}
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveNotebookName(notebook.id)}
                            disabled={updatingNotebookId === notebook.id}
                            className="text-emerald-600 hover:text-emerald-700 disabled:opacity-50 transition-colors"
                            title="Salvar"
                          >
                            ✓
                          </button>
                          <button
                            type="button"
                            onClick={handleCancelEdit}
                            disabled={updatingNotebookId === notebook.id}
                            className="text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors"
                            title="Cancelar"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <>
                          <h3 className="text-base font-semibold text-slate-900 mb-1 group-hover:text-slate-700 transition-colors">
                            {notebook.name}
                          </h3>
                          {notebook.description && (
                            <p className="text-sm text-slate-600 line-clamp-2">{notebook.description}</p>
                          )}
                        </>
                      )}
                    </div>
                    {editingNotebookId !== notebook.id && (
                      <div className="relative ml-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenDropdownId(openDropdownId === notebook.id ? null : notebook.id);
                          }}
                          className="text-slate-400 hover:text-slate-600 disabled:opacity-50 transition-colors duration-200 opacity-0 group-hover:opacity-100 p-1"
                          title="Mais opções"
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                            />
                          </svg>
                        </button>
                        {openDropdownId === notebook.id && (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              onClick={() => setOpenDropdownId(null)}
                            />
                            <div className="absolute right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-20">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEditNotebook(notebook);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-2"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                  />
                                </svg>
                                Editar nome
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteNotebook(notebook.id);
                                }}
                                disabled={deletingNotebookId === notebook.id}
                                className="w-full text-left px-4 py-2 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors flex items-center gap-2"
                              >
                                <svg
                                  className="w-4 h-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                                {deletingNotebookId === notebook.id ? 'Excluindo...' : 'Excluir'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <div 
                    className="flex items-center text-xs text-slate-500 mt-4 cursor-pointer"
                    onClick={() => handleNotebookClick(notebook.id)}
                  >
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
                className="rounded-xl px-6 py-3 text-sm font-medium text-white transition-all duration-200 hover:shadow-lg active:scale-[0.98]"
                style={{ backgroundColor: '#085E83' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
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
                  className="rounded-xl px-6 py-3 text-sm font-medium text-white transition-all duration-200 hover:shadow-lg active:scale-[0.98]"
                style={{ backgroundColor: '#085E83' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
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
                    className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 active:scale-[0.98]"
                    style={{ backgroundColor: '#085E83' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
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
          <div className="fixed bottom-4 right-4 text-white px-4 py-2 rounded-lg shadow-lg text-sm animate-in slide-in-from-bottom-4 duration-200 z-50" style={{ backgroundColor: '#085E83' }}>
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
            <span className="rounded-full px-3 py-1 text-xs text-white animate-in fade-in duration-200" style={{ backgroundColor: '#085E83' }}>
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
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                style={{ backgroundColor: '#085E83' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
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
        <div className="flex-1 flex flex-col overflow-hidden bg-white relative">
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto" style={{ paddingBottom: '160px' }}>
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
                      <div className={`${message.role === 'user' ? 'order-2 flex justify-end w-full' : 'flex-1 '}`}>
                        {message.role === 'user' ? (
                          <div className="rounded-2xl rounded-tr-[8px] px-4 py-3 transition-all duration-200 bg-slate-100 text-slate-900 w-auto max-w-[85%] animate-in fade-in duration-300">
                            {message.pending ? (
                              <div className="text-sm leading-relaxed opacity-70 break-words whitespace-pre-wrap">
                                {message.content}
                              </div>
                            ) : (
                              <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                                {message.content}
                              </div>
                            )}
                          </div>
                        ) : (
                          <>
                            {message.pending ? (
                              <div className="flex items-center gap-2 text-slate-500">
                                <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-slate-400"></span>
                                <span className="text-sm">Pensando...</span>
                              </div>
                            ) : (
                              <div className={`text-sm leading-relaxed ${message.pending ? 'opacity-70' : ''}`}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                  {formatMessageContent(typingMessages[message.id] ?? message.content)}
                                </ReactMarkdown>
                              </div>
                            )}
                            {!message.pending && (
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
                                        ? 'text-white shadow-sm'
                                        : 'border-slate-300 text-slate-600 hover:border-slate-400 hover:bg-slate-50'
                                    }`}
                                    style={draft.rating === option.value ? { backgroundColor: '#085E83', borderColor: '#085E83' } : {}}
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
                                      className="rounded-full px-4 py-1 text-white text-xs font-semibold disabled:opacity-50 transition-all duration-200 hover:shadow-md active:scale-[0.98]"
                                      style={{ backgroundColor: '#085E83' }}
                                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#064d6a'}
                                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
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
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input de mensagem */}
          <div className="absolute bottom-0 left-0 right-0 flex flex-col items-center px-4" style={{ bottom: '20px' }}>
            <form 
              className="max-w-3xl w-full flex flex-col gap-2 border border-slate-300 rounded-[20px] bg-white shadow-lg transition-all duration-200 focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-200/50 p-2"
              onSubmit={handleSendMessage}
            >
              {/* campoDigitacao */}
              <textarea
                value={chatInput}
                onChange={(event) => {
                  setChatInput(event.target.value);
                  const textarea = event.target;
                  textarea.style.height = 'auto';
                  const maxHeight = 1.5 * 16 * 4; // 4 linhas * 1.5rem * 16px
                  const newHeight = Math.min(textarea.scrollHeight, maxHeight);
                  textarea.style.height = `${newHeight}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (chatInput.trim() && !sendingMessage && selectedChatId) {
                      handleSendMessage(e as any);
                    }
                  }
                }}
                placeholder="Tire dúvidas sobre o documento..."
                rows={1}
                className="w-full px-4 py-3 text-sm resize-none border-0 focus:outline-none focus:ring-0 bg-transparent overflow-y-auto"
                style={{
                  minHeight: '1.5rem',
                  lineHeight: '1.5rem',
                  maxHeight: '6rem'
                }}
                disabled={!selectedChatId || sendingMessage}
              />
              {/* areaAcoes */}
              <div className="flex items-center justify-end gap-1 pr-2 pb-1">
                {/* botaoEnviar */}
                <button
                  type="submit"
                  disabled={!selectedChatId || sendingMessage || !chatInput.trim()}
                  className="flex-shrink-0 w-8 h-8 rounded-full text-white disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200 active:scale-[0.95] flex items-center justify-center"
                  style={{ backgroundColor: '#085E83' }}
                  onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.backgroundColor = '#064d6a')}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#085E83'}
                  title="Enviar"
                >
                  {sendingMessage ? (
                    <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-white"></span>
                  ) : (
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  )}
                </button>
                {/* featureFutura1 */}
                {/* featureFutura2 */}
                {/* featureFutura... */}
              </div>
            </form>
            <p className="max-w-3xl w-full text-xs text-slate-500 mt-2 text-center px-2">
              A IA pode cometer erros. Sempre verifique o documento na íntegra.
            </p>
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

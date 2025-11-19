export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface DocumentsRow {
  id: string;
  title: string | null;
  original_filename: string;
  storage_path: string;
  mime_type: string | null;
  num_pages: number | null;
  status: 'pending' | 'processing' | 'ready' | 'error';
  language: string | null;
  summary: string | null;
  metadata: Json | null;
  error_message: string | null;
  tokens_estimated: number | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentChunksRow {
  id: number;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  embedding: number[] | null;
  page_number: number | null;
  section: string | null;
  metadata: Json | null;
  created_at: string;
}

export interface NotebookRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotebookDocumentRow {
  notebook_id: string;
  document_id: string;
  added_at: string;
}

export interface ChatRow {
  id: string;
  notebook_id: string | null;
  title: string | null;
  status: 'active' | 'archived';
  metadata: Json | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

export interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  citations: Json | null;
  token_usage: Json | null;
  metadata: Json | null;
  created_at: string;
}

export interface ChatFeedbackRow {
  id: string;
  chat_id: string;
  notebook_id: string;
  message_id: string;
  user_message_id: string | null;
  rating: 'useful' | 'incomplete' | 'incorrect';
  question: string;
  answer: string;
  notes: string | null;
  revised_answer: string | null;
  applied_chunk_ids: number[] | null;
  question_embedding: number[] | null;
  metadata: Json | null;
  created_at: string;
}

export interface ChunkQuestionSignalRow {
  id: string;
  chunk_id: number;
  notebook_id: string;
  question: string;
  keywords: string[] | null;
  created_at: string;
}

export interface RagTurnTelemetryRow {
  id: string;
  chat_id: string;
  notebook_id: string;
  user_message: string;
  answer_preview: string | null;
  retrieved_chunks: Json | null;
  coverage: Json | null;
  auto_review: Json | null;
  feedback_context: Json | null;
  prompt_version: string | null;
  created_at: string;
}

export interface ProcessingJobRow {
  id: string;
  document_id: string;
  stage:
    | 'upload'
    | 'ocr'
    | 'ocr_correction'
    | 'text_extraction'
    | 'chunking'
    | 'embedding'
    | 'summary'
    | 'completed'
    | 'failed';
  status: 'pending' | 'running' | 'completed' | 'failed';
  payload: Json | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface Database {
  public: {
    Tables: {
      documents: {
        Row: DocumentsRow;
        Insert: Partial<DocumentsRow> & Pick<DocumentsRow, 'original_filename' | 'storage_path'>;
        Update: Partial<DocumentsRow>;
      };
      document_chunks: {
        Row: DocumentChunksRow;
        Insert: Omit<DocumentChunksRow, 'id' | 'created_at'> & { id?: number };
        Update: Partial<DocumentChunksRow>;
      };
      notebooks: {
        Row: NotebookRow;
        Insert: Pick<NotebookRow, 'name'> & Partial<NotebookRow>;
        Update: Partial<NotebookRow>;
      };
      notebook_documents: {
        Row: NotebookDocumentRow;
        Insert: NotebookDocumentRow;
        Update: Partial<NotebookDocumentRow>;
      };
      chats: {
        Row: ChatRow;
        Insert: Partial<ChatRow>;
        Update: Partial<ChatRow>;
      };
      chat_messages: {
        Row: ChatMessageRow;
        Insert: Pick<ChatMessageRow, 'chat_id' | 'role' | 'content'> & Partial<ChatMessageRow>;
        Update: Partial<ChatMessageRow>;
      };
      chat_feedback: {
        Row: ChatFeedbackRow;
        Insert: Omit<ChatFeedbackRow, 'id' | 'created_at'> & { id?: string };
        Update: Partial<ChatFeedbackRow>;
      };
      processing_jobs: {
        Row: ProcessingJobRow;
        Insert: Pick<ProcessingJobRow, 'document_id' | 'stage' | 'status'> & Partial<ProcessingJobRow>;
        Update: Partial<ProcessingJobRow>;
      };
      chunk_question_signals: {
        Row: ChunkQuestionSignalRow;
        Insert: Omit<ChunkQuestionSignalRow, 'id' | 'created_at'> & { id?: string };
        Update: Partial<ChunkQuestionSignalRow>;
      };
      rag_turn_telemetry: {
        Row: RagTurnTelemetryRow;
        Insert: Omit<RagTurnTelemetryRow, 'id' | 'created_at'> & { id?: string };
        Update: Partial<RagTurnTelemetryRow>;
      };
    };
    Functions: {
      match_chunks: {
        Args: {
          in_notebook_id: string;
          query_embedding: number[];
          match_count?: number;
          similarity_threshold?: number;
        };
        Returns: {
          document_id: string;
          chunk_id: number;
          content: string;
          page_number: number | null;
          similarity: number;
        }[];
      };
      match_feedback_samples: {
        Args: {
          in_notebook_id: string;
          query_embedding: number[];
          match_count?: number;
          similarity_threshold?: number;
        };
        Returns: {
          id: string;
          question: string;
          revised_answer: string | null;
          notes: string | null;
          similarity: number;
        }[];
      };
    };
  };
}

// 共享类型定义

export interface TreeNode {
  name: string
  type: 'file' | 'directory' | 'folder'
  children?: TreeNode[]
  size?: number
}

export interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    model?: string;
    tokens?: number;
    duration?: number;
  };
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  result?: unknown;
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number;
  tools: Tool[];
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  type: 'react' | 'vue' | 'node' | 'python' | 'other';
  lastOpened: number;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  fontSize: 'small' | 'medium' | 'large';
  sidebarVisible: boolean;
  autoSave: boolean;
}

// API 响应类型
export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// 事件类型
export type AppEvent =
  | { type: 'message:received'; payload: Message }
  | { type: 'message:sent'; payload: Message }
  | { type: 'task:updated'; payload: Task }
  | { type: 'settings:changed'; payload: Partial<AppSettings> };

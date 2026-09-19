"use client";

import { useState, useEffect, useRef } from "react";
import { 
  Upload, 
  Search, 
  Database, 
  FolderOpen, 
  ChevronRight,
  Plus,
  MoreVertical,
  Edit2,
  Trash2,
  Check,
  X
} from "lucide-react";
import { collectionApi } from "@/lib/api";
import type { CollectionInfo } from "@/types";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  selectedCollection: string;
  onCollectionChange: (collection: string) => void;
  activeTab: "documents" | "chat";
  onTabChange: (tab: "documents" | "chat") => void;
  onCollectionCreate?: () => void;
}

type EditMode = "none" | "create" | "rename";

export function Sidebar({
  isOpen,
  onClose,
  selectedCollection,
  onCollectionChange,
  activeTab,
  onTabChange,
  onCollectionCreate,
}: SidebarProps) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("none");
  const [editingCollection, setEditingCollection] = useState<string>("");
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadCollections();
  }, []);

  useEffect(() => {
    if (editMode !== "none" && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editMode]);

  const loadCollections = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await collectionApi.list();
      setCollections(data);
    } catch (error) {
      console.error("Failed to load collections:", error);
      setError("加载知识库失败");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditMode("create");
    setInputValue("");
    setError(null);
    setContextMenu(null);
  };

  const handleRename = (name: string) => {
    setEditMode("rename");
    setEditingCollection(name);
    setInputValue(name);
    setError(null);
    setContextMenu(null);
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`确定要删除知识库 \"${name}\" 吗？此操作不可撤销。`)) {
      return;
    }

    setContextMenu(null);
    try {
      await collectionApi.delete(name);
      await loadCollections();
      
      if (selectedCollection === name) {
        onCollectionChange("default");
      }
      
      onCollectionCreate?.();
    } catch (error: any) {
      setError(error.response?.data?.detail || "删除失败");
    }
  };

  const handleSubmit = async () => {
    const value = inputValue.trim();
    
    if (!value) {
      setError("名称不能为空");
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      setError("名称只能包含字母、数字、下划线和连字符");
      return;
    }

    setError(null);

    try {
      if (editMode === "create") {
        await collectionApi.create(value);
      } else if (editMode === "rename") {
        await collectionApi.rename(editingCollection, value);
        
        if (selectedCollection === editingCollection) {
          onCollectionChange(value);
        }
      }

      await loadCollections();
      setEditMode("none");
      setEditingCollection("");
      setInputValue("");
      onCollectionCreate?.();
    } catch (error: any) {
      setError(error.response?.data?.detail || "操作失败");
    }
  };

  const handleCancel = () => {
    setEditMode("none");
    setEditingCollection("");
    setInputValue("");
    setError(null);
    setContextMenu(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  const toggleContextMenu = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu(contextMenu === name ? null : name);
  };

  useEffect(() => {
    const handleClickOutside = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener("click", handleClickOutside);
    }
    return () => document.removeEventListener("click", handleClickOutside);
  }, [contextMenu]);

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 z-50 w-72 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-gray-700 transform transition-transform duration-300",
          "lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="h-full flex flex-col">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
              导航
            </h2>
          </div>

          <div className="p-3">
            <nav className="space-y-1">
              <button
                onClick={() => {
                  onTabChange("documents");
                  onClose();
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  activeTab === "documents"
                    ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                )}
              >
                <Upload className="w-5 h-5" />
                <span>文档管理</span>
              </button>

              <button
                onClick={() => {
                  onTabChange("chat");
                  onClose();
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  activeTab === "chat"
                    ? "bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                )}
              >
                <Search className="w-5 h-5" />
                <span>智能问答</span>
              </button>
            </nav>
          </div>

          <div className="p-4 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  知识库
                </h3>
              </div>
              {editMode === "none" && (
                <button
                  onClick={handleCreate}
                  className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                  title="创建知识库"
                >
                  <Plus className="w-4 h-4 text-gray-500" />
                </button>
              )}
            </div>

            {error && (
              <div className="mb-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {editMode !== "none" && (
              <div className="mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  {editMode === "create" ? "创建新知识库" : "重命名知识库"}
                </p>
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="输入名称..."
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-slate-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  <button
                    onClick={handleSubmit}
                    className="p-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={handleCancel}
                    className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  >
                    <X className="w-4 h-4 text-gray-500" />
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1 max-h-64 overflow-y-auto">
              {loading ? (
                <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
                  加载中...
                </div>
              ) : collections.length === 0 ? (
                <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
                  暂无知识库
                </div>
              ) : (
                collections.map((collection) => (
                  <div key={collection.name} className="relative">
                    <button
                      onClick={() => {
                        onCollectionChange(collection.name);
                        onClose();
                      }}
                      className={cn(
                        "w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors pr-10",
                        selectedCollection === collection.name
                          ? "bg-secondary-50 dark:bg-secondary-900/20 text-secondary-700 dark:text-secondary-400 font-medium"
                          : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FolderOpen className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate max-w-[120px]">
                          {collection.name}
                        </span>
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {collection.document_count} 文档
                      </span>
                    </button>

                    <div className="absolute right-1 top-1/2 -translate-y-1/2">
                      <button
                        onClick={(e) => toggleContextMenu(collection.name, e)}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors opacity-0 group-hover:opacity-100 hover:opacity-100"
                      >
                        <MoreVertical className="w-3.5 h-3.5 text-gray-500" />
                      </button>

                      {contextMenu === collection.name && (
                        <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-slate-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 z-10">
                          <button
                            onClick={() => handleRename(collection.name)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          >
                            <Edit2 className="w-4 h-4" />
                            重命名
                          </button>
                          {collection.name !== "default" && (
                            <button
                              onClick={() => handleDelete(collection.name)}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                              删除
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-auto p-4 border-t border-gray-200 dark:border-gray-700">
            <div className="bg-gradient-to-r from-primary-500 to-secondary-500 rounded-lg p-4 text-white">
              <h4 className="font-semibold text-sm mb-1">当前知识库</h4>
              <p className="text-xs opacity-90 mb-2">
                {selectedCollection || "default"}
              </p>
              {collections.find((c) => c.name === selectedCollection) && (
                <div className="text-xs opacity-75">
                  {collections.find((c) => c.name === selectedCollection)
                    ?.document_count || 0}{" "}
                  个文档 ·{" "}
                  {collections.find((c) => c.name === selectedCollection)
                    ?.chunk_count || 0}{" "}
                  个片段
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

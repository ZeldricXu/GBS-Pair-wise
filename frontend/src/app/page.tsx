"use client";

import { useState } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { DocumentUploader } from "@/components/DocumentUploader";
import { DocumentList } from "@/components/DocumentList";
import { ChatInterface } from "@/components/ChatInterface";
import { SettingsModal } from "@/components/SettingsModal";
import { Upload, MessageSquare } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState("default");
  const [activeTab, setActiveTab] = useState<"documents" | "chat">("documents");
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeUploads, setActiveUploads] = useState(0);

  const handleUploadComplete = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleCollectionChange = (collection: string) => {
    if (collection !== selectedCollection && activeUploads > 0) {
      const confirmed = window.confirm(
        `当前有 ${activeUploads} 个文件正在上传到知识库「${selectedCollection}」。\n\n切换知识库不会中断上传，文件仍会传入原知识库。确定要切换吗？`
      );
      if (!confirmed) {
        return;
      }
    }
    setSelectedCollection(collection);
  };

  const handleCollectionCreate = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-slate-900">
      <Header 
        onMenuClick={() => setSidebarOpen(true)}
        onSettingsClick={() => setSettingsOpen(true)}
      />

      <SettingsModal 
        isOpen={settingsOpen} 
        onClose={() => setSettingsOpen(false)} 
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          selectedCollection={selectedCollection}
          onCollectionChange={handleCollectionChange}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onCollectionCreate={handleCollectionCreate}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-slate-800">
            <div className="flex">
              <button
                onClick={() => setActiveTab("documents")}
                className={cn(
                  "flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2",
                  activeTab === "documents"
                    ? "text-primary-600 dark:text-primary-400 border-primary-600 dark:border-primary-400"
                    : "text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-300"
                )}
              >
                <Upload className="w-4 h-4" />
                文档管理
              </button>
              <button
                onClick={() => setActiveTab("chat")}
                className={cn(
                  "flex items-center gap-2 px-6 py-3 text-sm font-medium transition-colors border-b-2",
                  activeTab === "chat"
                    ? "text-primary-600 dark:text-primary-400 border-primary-600 dark:border-primary-400"
                    : "text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-300"
                )}
              >
                <MessageSquare className="w-4 h-4" />
                智能问答
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {activeTab === "documents" ? (
              <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
                <div className="max-w-5xl mx-auto space-y-8">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                      上传文档
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      上传 PDF、Markdown 或 TXT 文件到知识库 "{selectedCollection}"
                    </p>
                  </div>

                  <DocumentUploader
                    collectionName={selectedCollection}
                    onUploadComplete={handleUploadComplete}
                    onActiveUploadsChange={setActiveUploads}
                  />

                  <div className="border-t border-gray-200 dark:border-gray-700 pt-8">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
                      已上传文档
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                      管理知识库 "{selectedCollection}" 中的文档
                    </p>

                    <DocumentList
                      collectionName={selectedCollection}
                      refreshTrigger={refreshTrigger}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full">
                <ChatInterface collectionName={selectedCollection} />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

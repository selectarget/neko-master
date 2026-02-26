"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Play, Square, RotateCw, Download, FileText, Terminal, Settings2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function ClientPage() {
  const [subUrl, setSubUrl] = useState("");

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["proxyStatus"],
    queryFn: () => api.getProxyStatus(),
    refetchInterval: 2000,
  });

  const { data: logsData } = useQuery({
    queryKey: ["proxyLogs"],
    queryFn: () => api.getProxyLogs(100),
    refetchInterval: status?.running ? 2000 : false,
    enabled: !!status?.running
  });

  const startMutation = useMutation({
    mutationFn: () => api.startProxy(),
    onSuccess: () => {
      toast.success("Proxy started");
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to start proxy: " + err.message),
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopProxy(),
    onSuccess: () => {
      toast.success("Proxy stopped");
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to stop proxy: " + err.message),
  });

  const restartMutation = useMutation({
    mutationFn: () => api.restartProxy(),
    onSuccess: () => {
      toast.success("Proxy restarted");
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to restart proxy: " + err.message),
  });

  const updateConfigMutation = useMutation({
    mutationFn: (url: string) => api.updateProxyConfig(url),
    onSuccess: () => {
      toast.success("Configuration updated");
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to update config: " + err.message),
  });

  const handleUpdateConfig = () => {
    if (!subUrl) {
      toast.error("Please enter a subscription URL");
      return;
    }
    updateConfigMutation.mutate(subUrl);
  };

  const logs = logsData?.logs || [];

  return (
    <div className="space-y-6">
      {/* Status Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="w-5 h-5" />
            Client Status
          </CardTitle>
          <CardDescription>Manage your local proxy client</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4 mb-6">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">Status:</span>
              <Badge variant={status?.running ? "default" : "secondary"} className={cn(status?.running && "bg-emerald-500 hover:bg-emerald-600")}>
                {status?.running ? "Running" : "Stopped"}
              </Badge>
            </div>
            {status?.running && (
               <>
                 <div className="flex items-center gap-2">
                   <span className="text-sm font-medium text-muted-foreground">Version:</span>
                   <span className="text-sm font-mono">{status.version}</span>
                 </div>
                 <div className="flex items-center gap-2">
                   <span className="text-sm font-medium text-muted-foreground">System Proxy:</span>
                   <Badge variant={status.systemProxy ? "default" : "outline"}>
                     {status.systemProxy ? "On" : "Off"}
                   </Badge>
                 </div>
               </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!status?.running ? (
              <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending} className="w-32">
                <Play className="w-4 h-4 mr-2" /> Start
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending} className="w-32">
                <Square className="w-4 h-4 mr-2" /> Stop
              </Button>
            )}
            <Button variant="outline" onClick={() => restartMutation.mutate()} disabled={restartMutation.isPending}>
              <RotateCw className="w-4 h-4 mr-2" /> Restart
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="config" className="w-full">
        <TabsList>
          <TabsTrigger value="config" className="flex items-center gap-2">
            <FileText className="w-4 h-4" /> Configuration
          </TabsTrigger>
          <TabsTrigger value="logs" className="flex items-center gap-2">
            <Terminal className="w-4 h-4" /> Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Subscription</CardTitle>
              <CardDescription>Update your proxy configuration from a subscription URL.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Subscription URL</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://example.com/sub/..."
                    value={subUrl}
                    onChange={(e) => setSubUrl(e.target.value)}
                    className="flex-1"
                  />
                  <Button onClick={handleUpdateConfig} disabled={updateConfigMutation.isPending}>
                    <Download className="w-4 h-4 mr-2" /> Update
                  </Button>
                </div>
                {status?.subscriptionUrl && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Current: {status.subscriptionUrl}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Process Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-black/90 text-zinc-400 p-4 rounded-lg font-mono text-xs h-[400px] overflow-y-auto whitespace-pre-wrap">
                {logs.length > 0 ? logs.join('\n') : "No logs available..."}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

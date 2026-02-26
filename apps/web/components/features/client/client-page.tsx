"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Play, Square, RotateCw, FileText, Terminal, Settings2, ShieldAlert, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ClientPage() {
  const [subUrl, setSubUrl] = useState("");
  const [profileName, setProfileName] = useState("");
  const [isAddProfileOpen, setIsAddProfileOpen] = useState(false);

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["proxyStatus"],
    queryFn: () => api.getProxyStatus(),
    refetchInterval: 2000,
  });

  const { data: profilesData, refetch: refetchProfiles } = useQuery({
    queryKey: ["proxyProfiles"],
    queryFn: () => api.getProxyProfiles(),
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
    mutationFn: (data: { url: string, name?: string }) => api.updateProxyConfig(data.url, data.name),
    onSuccess: () => {
      toast.success("Configuration updated");
      refetchStatus();
      refetchProfiles();
      setIsAddProfileOpen(false);
      setSubUrl("");
      setProfileName("");
    },
    onError: (err) => toast.error("Failed to update config: " + err.message),
  });

  const switchProfileMutation = useMutation({
    mutationFn: (name: string) => api.switchProxyProfile(name),
    onSuccess: (_, name) => {
      toast.success(`Switched to profile: ${name}`);
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to switch profile: " + err.message),
  });

  const deleteProfileMutation = useMutation({
    mutationFn: (name: string) => api.deleteProxyProfile(name),
    onSuccess: () => {
      toast.success("Profile deleted");
      refetchProfiles();
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to delete profile: " + err.message),
  });

  const tunMutation = useMutation({
    mutationFn: (enable: boolean) => api.setTunMode(enable),
    onSuccess: (_, enable) => {
      toast.success(enable ? "TUN mode enabled" : "TUN mode disabled");
      refetchStatus();
    },
    onError: (err) => toast.error("Failed to toggle TUN mode: " + err.message),
  });

  const handleAddProfile = () => {
    if (!subUrl) {
      toast.error("Please enter a subscription URL");
      return;
    }
    if (!profileName) {
      toast.error("Please enter a profile name");
      return;
    }
    updateConfigMutation.mutate({ url: subUrl, name: profileName });
  };

  const logs = logsData?.logs || [];
  const profiles = profilesData?.profiles || [];

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

        <TabsContent value="config" className="mt-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Profiles</CardTitle>
                <CardDescription>Manage your proxy configuration profiles.</CardDescription>
              </div>
              <Dialog open={isAddProfileOpen} onOpenChange={setIsAddProfileOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="w-4 h-4 mr-2" /> Add Profile
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add New Profile</DialogTitle>
                    <DialogDescription>
                      Enter a name and subscription URL for the new profile.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label>Profile Name</Label>
                      <Input
                        placeholder="e.g. My Provider"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Subscription URL</Label>
                      <Input
                        placeholder="https://example.com/sub/..."
                        value={subUrl}
                        onChange={(e) => setSubUrl(e.target.value)}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleAddProfile} disabled={updateConfigMutation.isPending}>
                      {updateConfigMutation.isPending ? "Adding..." : "Add Profile"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                 {profiles.length === 0 && (
                    <div className="col-span-full text-center text-muted-foreground py-8">
                      No profiles found. Add one to get started.
                    </div>
                 )}
                 {profiles.map((profile: { name: string; updatedAt: string }) => {
                   const isActive = status?.activeProfile === profile.name;
                   return (
                     <div key={profile.name} className={cn("rounded-lg border p-4 flex flex-col gap-3", isActive && "border-primary bg-primary/5")}>
                       <div className="flex items-start justify-between">
                         <div className="flex items-center gap-2">
                           <span className="font-medium">{profile.name}</span>
                           {isActive && <CheckCircle2 className="w-4 h-4 text-primary" />}
                         </div>
                         {!isActive && (
                           <Button
                             variant="ghost"
                             size="icon"
                             className="h-8 w-8 text-muted-foreground hover:text-destructive"
                             onClick={() => deleteProfileMutation.mutate(profile.name)}
                           >
                             <Trash2 className="w-4 h-4" />
                           </Button>
                         )}
                       </div>
                       <div className="text-xs text-muted-foreground">
                         Updated: {new Date(profile.updatedAt).toLocaleDateString()}
                       </div>
                       <Button
                         variant={isActive ? "secondary" : "outline"}
                         className="w-full mt-auto"
                         disabled={isActive || switchProfileMutation.isPending}
                         onClick={() => switchProfileMutation.mutate(profile.name)}
                       >
                         {isActive ? "Active" : "Activate"}
                       </Button>
                     </div>
                   );
                 })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-500" />
                Advanced Settings
              </CardTitle>
              <CardDescription>Experimental features for advanced users.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Alert className="bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400">
                 <ShieldAlert className="w-4 h-4" />
                 <AlertTitle>Warning</AlertTitle>
                 <AlertDescription>
                   Enabling TUN mode requires administrator privileges. Your network connection might be briefly interrupted.
                 </AlertDescription>
              </Alert>

              <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
                <div className="space-y-0.5">
                  <Label className="text-base">TUN Mode</Label>
                  <p className="text-sm text-muted-foreground">
                    Enable system-wide proxy via virtual network interface
                  </p>
                </div>
                <Switch
                  checked={status?.tunMode}
                  onCheckedChange={(c) => tunMutation.mutate(c)}
                  disabled={tunMutation.isPending}
                />
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

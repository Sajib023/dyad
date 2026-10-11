import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useCustomLanguageModelProvider } from "@/hooks/useCustomLanguageModelProvider";
import type {
  CustomProviderApiProtocol,
  LanguageModelProvider,
} from "@/ipc/types";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

interface CreateCustomProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  editingProvider?: LanguageModelProvider | null;
}

export function CreateCustomProviderDialog({
  isOpen,
  onClose,
  onSuccess,
  editingProvider = null,
}: CreateCustomProviderDialogProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [apiProtocol, setApiProtocol] =
    useState<CustomProviderApiProtocol>("openai");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [envVarName, setEnvVarName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const isEditMode = Boolean(editingProvider);

  const { createProvider, editProvider, isCreating, isEditing, error } =
    useCustomLanguageModelProvider();
  // Load provider data when editing
  useEffect(() => {
    if (editingProvider && isOpen) {
      const cleanId = editingProvider.id?.startsWith("custom::")
        ? editingProvider.id.replace("custom::", "")
        : editingProvider.id || "";
      setId(cleanId);
      setName(editingProvider.name || "");
      setApiProtocol(editingProvider.apiProtocol ?? "openai");
      setApiBaseUrl(editingProvider.apiBaseUrl || "");
      setEnvVarName(editingProvider.envVarName || "");
    } else if (!isOpen) {
      // Reset form when dialog closes
      setId("");
      setName("");
      setApiProtocol("openai");
      setApiBaseUrl("");
      setEnvVarName("");
      setErrorMessage("");
    }
  }, [editingProvider, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");

    try {
      if (isEditMode && editingProvider) {
        const cleanId = editingProvider.id?.startsWith("custom::")
          ? editingProvider.id.replace("custom::", "")
          : editingProvider.id || "";
        await editProvider({
          id: cleanId,
          name: name.trim(),
          apiBaseUrl: apiBaseUrl.trim(),
          apiProtocol,
          envVarName: envVarName.trim() || undefined,
        });
      } else {
        await createProvider({
          id: id.trim(),
          name: name.trim(),
          apiBaseUrl: apiBaseUrl.trim(),
          apiProtocol,
          envVarName: envVarName.trim() || undefined,
        });
      }

      // Reset form
      setId("");
      setName("");
      setApiProtocol("openai");
      setApiBaseUrl("");
      setEnvVarName("");

      onSuccess();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Failed to ${isEditMode ? "edit" : "create"} custom provider`,
      );
    }
  };

  const handleClose = () => {
    if (!isCreating && !isEditing) {
      setErrorMessage("");
      onClose();
    }
  };
  const isLoading = isCreating || isEditing;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Custom Provider" : "Add Custom Provider"}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update your custom language model provider configuration."
              : "Connect to a custom language model provider API."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="id">Provider ID</Label>
            <Input
              id="id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="E.g., my-provider"
              required
              disabled={isLoading || isEditMode}
            />
            <p className="text-xs text-muted-foreground">
              A unique identifier for this provider (no spaces).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Display Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="E.g., My Provider"
              required
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              The name that will be displayed in the UI.
            </p>
          </div>

          <div className="space-y-2">
            <Label>API Protocol</Label>
            <RadioGroup
              value={apiProtocol}
              onValueChange={(value: string) =>
                setApiProtocol(value as CustomProviderApiProtocol)
              }
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem
                  value="openai"
                  id="protocol-openai"
                  disabled={isLoading}
                />
                <Label htmlFor="protocol-openai" className="font-normal">
                  OpenAI-compatible
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem
                  value="anthropic"
                  id="protocol-anthropic"
                  disabled={isLoading}
                />
                <Label htmlFor="protocol-anthropic" className="font-normal">
                  Anthropic-compatible
                </Label>
              </div>
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              OpenAI-compatible covers OpenAI-style chat APIs (Ollama, vLLM,
              OpenRouter, …). Choose Anthropic-compatible for Messages-API
              endpoints.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiBaseUrl">API Base URL</Label>
            <Input
              id="apiBaseUrl"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="E.g., https://api.example.com/v1"
              required
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              The base URL for the API endpoint.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="envVarName">Environment Variable (Optional)</Label>
            <Input
              id="envVarName"
              value={envVarName}
              onChange={(e) => setEnvVarName(e.target.value)}
              placeholder="E.g., MY_PROVIDER_API_KEY"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Environment variable name for the API key.
            </p>
          </div>

          {(errorMessage || error) && (
            <div className="text-sm text-red-500">
              {errorMessage ||
                (error instanceof Error
                  ? error.message
                  : "Failed to create custom provider")}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLoading
                ? isEditMode
                  ? "Updating..."
                  : "Adding..."
                : isEditMode
                  ? "Update Provider"
                  : "Add Provider"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

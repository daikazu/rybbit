import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "@/api/utils";
import { APIResponse } from "@/api/types";
import type { AllowedDateRange } from "@/lib/import/types";

interface GetSiteImportsResponse {
  importId: string;
  platform: "umami";
  status: "pending" | "processing" | "completed" | "failed";
  importedEvents: number;
  errorMessage: string | null;
  startedAt: string;
  fileName: string;
}

interface CreateSiteImportParams {
  platform: "umami";
  fileName: string;
}

interface CreateSiteImportResponse {
  importId: string;
  allowedDateRange: AllowedDateRange;
}

interface DeleteImportResponse {
  message: string;
}

export function useGetSiteImports(site: number) {
  return useQuery({
    queryKey: ["get-site-imports", site],
    queryFn: async () => await authedFetch<APIResponse<GetSiteImportsResponse[]>>(`/get-site-imports/${site}`),
    refetchInterval: data => {
      const hasActiveImports = data.state.data?.data.some(
        imp => imp.status === "processing" || imp.status === "pending"
      );
      return hasActiveImports ? 5000 : false;
    },
    placeholderData: { data: [] },
    staleTime: 30000,
  });
}

export function useCreateSiteImport(site: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateSiteImportParams) => {
      return await authedFetch<APIResponse<CreateSiteImportResponse>>(
        `/create-site-import/${site}`,
        undefined,
        {
          method: "POST",
          data: params,
        }
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["get-site-imports", site],
      });
    },
    retry: false,
  });
}

export function useDeleteSiteImport(site: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (importId: string) => {
      return await authedFetch<APIResponse<DeleteImportResponse>>(
        `/delete-site-import/${site}/${importId}`,
        undefined,
        {
          method: "DELETE",
        }
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["get-site-imports", site],
      });
    },
    retry: false,
  });
}

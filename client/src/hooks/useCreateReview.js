import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createReview } from "../common/ApiService";
import { getStoreDomain } from "../common/AuthStorage";
import { shopQueryKeys } from "../common/queryKeys";

export const useCreateReview = () => {
  const queryClient = useQueryClient();
  const storeDomain = getStoreDomain();

  return useMutation({
    mutationFn: ({ productId, data }) => createReview(productId, data),
    onSuccess: (_, variables) => {
      const productId = variables?.productId;
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.reviews(storeDomain, productId) });
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.reviewSummary(storeDomain, productId) });
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.allReviewsRoot(storeDomain) });
      queryClient.invalidateQueries({ queryKey: shopQueryKeys.dashboardOverview(storeDomain) });
    },
  });
};

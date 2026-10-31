export type FormMode = 'hidden' | 'optional' | 'required';

export interface WidgetConfig {
  formPhoneMode: FormMode;
  formEmailMode?: FormMode;
  formTitleMode?: FormMode;
  formContentMode?: FormMode;
  reviewQnaDisplayMode: 'tabs' | 'stacked';
  autoApprove?: boolean;
  requirePurchaseToReview?: boolean;
  requireLogin?: boolean;
  allowQnA?: boolean;
  allowImage?: boolean;
  allowVideo?: boolean;
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  formPhoneMode: 'optional',
  reviewQnaDisplayMode: 'tabs',
};

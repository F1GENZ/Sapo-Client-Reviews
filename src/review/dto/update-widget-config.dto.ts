import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const FORM_MODES = ['hidden', 'optional', 'required'] as const;
const HTTP_URL_OR_EMPTY = /^(https?:\/\/[^\s"'()<>\\]+)?$/;

export class UpdateWidgetConfigDto {
  @IsOptional() @IsString() @MaxLength(200) titleText?: string;
  @IsOptional() @IsString() @MaxLength(64) accentColor?: string;
  @IsOptional() @IsString() @MaxLength(64) starColor?: string;
  @IsOptional() @IsString() @MaxLength(64) starBgColor?: string;
  @IsOptional() @IsString() @MaxLength(2000) @Matches(HTTP_URL_OR_EMPTY, { message: 'starIconUrl must be an http(s) URL' }) starIconUrl?: string;
  @IsOptional() @IsString() @MaxLength(64) textColor?: string;
  @IsOptional() @IsString() @MaxLength(64) mutedColor?: string;
  @IsOptional() @IsString() @MaxLength(64) bgColor?: string;
  @IsOptional() @IsString() @MaxLength(64) bgAltColor?: string;
  @IsOptional() @IsString() @MaxLength(64) borderColor?: string;
  @IsOptional() @IsString() @MaxLength(64) verifiedColor?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(64) radius?: number;
  @IsOptional() @IsBoolean() autoApprove?: boolean;
  @IsOptional() @IsBoolean() showTitle?: boolean;
  @IsOptional() @IsBoolean() showDate?: boolean;
  @IsOptional() @IsBoolean() showFilter?: boolean;
  @IsOptional() @IsBoolean() showSort?: boolean;
  @IsOptional() @IsIn(FORM_MODES) formEmailMode?: string;
  @IsOptional() @IsIn(FORM_MODES) formPhoneMode?: 'hidden' | 'optional' | 'required';
  @IsOptional() @IsIn(FORM_MODES) formTitleMode?: string;
  @IsOptional() @IsIn(FORM_MODES) formContentMode?: string;
  @IsOptional() @IsIn(['list', 'grid', 'masonry']) reviewLayout?: string;
  @IsOptional() @IsIn(['tabs', 'stacked']) reviewQnaDisplayMode?: 'tabs' | 'stacked';
  @IsOptional() @IsInt() @Min(1) @Max(50) reviewItemsPerPage?: number;
  @IsOptional() @IsBoolean() allowImage?: boolean;
  @IsOptional() @IsBoolean() allowVideo?: boolean;
  @IsOptional() @IsBoolean() allowQnA?: boolean;
  @IsOptional() @IsString() @MaxLength(32) qnaDisplayMode?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) qnaItemsPerPage?: number;
  @IsOptional() @IsBoolean() allowReply?: boolean;
  @IsOptional() @IsString() @MaxLength(100) replyBadgeText?: string;
  @IsOptional() @IsString() @MaxLength(64) replyBgColor?: string;
  @IsOptional() @IsString() @MaxLength(64) replyBorderColor?: string;
  @IsOptional() @IsBoolean() showVerified?: boolean;
  @IsOptional() @IsBoolean() showVerifiedAll?: boolean;
  @IsOptional() @IsBoolean() requireLogin?: boolean;
  @IsOptional() @IsBoolean() requirePurchaseToReview?: boolean;
}

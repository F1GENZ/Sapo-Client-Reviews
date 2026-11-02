import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { OUTBOUND_EVENTS } from './outbound-webhook.service';

const EVENT_LIST = [...OUTBOUND_EVENTS] as string[];
const MAX_EVENTS = OUTBOUND_EVENTS.length;

export class CreateOutboundWebhookDto {
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @Length(8, 500)
  url!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_EVENTS)
  @IsIn(EVENT_LIST, { each: true })
  events!: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @Length(0, 200)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateOutboundWebhookDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== undefined && value !== '')
  @IsUrl({ protocols: ['https'], require_protocol: true, require_tld: false })
  @Length(8, 500)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_EVENTS)
  @IsIn(EVENT_LIST, { each: true })
  events?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @Length(0, 200)
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class DeliveryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}

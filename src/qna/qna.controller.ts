import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  NotFoundException,
  BadRequestException,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { ShopAuthGuard } from '../common/guards/shop-auth.guard';
import { QnaService } from './qna.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { AnswerQuestionDto, UpdateQuestionStatusDto } from './dto/answer-question.dto';
import { ValidationPipe } from '@nestjs/common';
import { NumericIdPipe } from '../common/pipes/numeric-id.pipe';
import { STORE_DOMAIN_RE } from '../common/security/public-limits';
import { QnaBulkDto, QnaImportDto } from './qna-data-tools.dto';
import { QnaDataToolsService } from './qna-data-tools.service';

type AuthRequest = {
  token?: string;
  storeDomain?: string;
};

function requireAuth(req: AuthRequest): asserts req is Required<AuthRequest> & { storeDomain: string } {
  if (!req.token || !req.storeDomain || !STORE_DOMAIN_RE.test(req.storeDomain)) {
    throw new BadRequestException('Missing or invalid auth');
  }
}

@Controller('api/admin/qna')
@UseGuards(ShopAuthGuard)
export class QnaController {
  constructor(
    private readonly qnaService: QnaService,
    private readonly dataTools: QnaDataToolsService,
  ) {}

  @Get('export')
  async exportQuestions(@Query('format') format: string | undefined, @Req() req: AuthRequest) {
    requireAuth(req);
    return { data: await this.dataTools.exportQuestions(req.storeDomain, format === 'json' ? 'json' : 'csv') };
  }

  @Get('import/history')
  async importHistory(@Req() req: AuthRequest) {
    requireAuth(req);
    return { data: await this.dataTools.listImportRuns(req.storeDomain) };
  }

  @Post('import/dry-run')
  async importDryRun(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: QnaImportDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return { data: await this.dataTools.importQuestions(req.storeDomain, { ...dto, dryRun: true }) };
  }

  @Post('import')
  async importQuestions(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: QnaImportDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return {
      data: await this.dataTools.importQuestions(req.storeDomain, {
        format: dto.format,
        body: dto.body,
        dryRun: dto.dryRun === true,
      }),
    };
  }

  @Post('bulk')
  async bulkQuestions(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    dto: QnaBulkDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    return { data: await this.dataTools.bulkQuestions(req.storeDomain, dto.action, dto.items) };
  }

  @Get()
  async listAllQuestions(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status: string | undefined,
    @Query('sort') sort: string | undefined,
    @Query('productId') productId: string | undefined,
    @Query('search') search: string | undefined,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const result = await this.qnaService.getAllQuestions(req.storeDomain, {
      page,
      limit,
      status,
      sort,
      productId,
      search,
    });
    return { data: result };
  }

  @Get(':productId')
  async getQuestions(
    @Param('productId', NumericIdPipe) productId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('size', new DefaultValuePipe(20), ParseIntPipe) size: number,
    @Query('status') status: string | undefined,
    @Query('sort') sort: string | undefined,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const result = await this.qnaService.getQuestions(req.storeDomain, productId, {
      page,
      limit: size,
      status,
      sort,
    });
    return { data: result };
  }

  @Get(':productId/stats')
  async getStats(
    @Param('productId', NumericIdPipe) productId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const stats = await this.qnaService.getStats(req.storeDomain, productId);
    return { data: stats };
  }

  @Post(':productId')
  async createQuestion(
    @Param('productId', NumericIdPipe) productId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: CreateQuestionDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const question = await this.qnaService.submitQuestion(req.storeDomain, productId, dto);
    return { data: question };
  }

  @Patch(':productId/:questionId')
  async updateQuestion(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('questionId') questionId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateQuestionDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const question = await this.qnaService.updateQuestion(
      req.storeDomain,
      productId,
      questionId,
      dto,
    );
    if (!question) throw new NotFoundException('Question not found');
    return { data: question };
  }

  @Patch(':productId/:questionId/status')
  async updateStatus(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('questionId') questionId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: UpdateQuestionStatusDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const question = await this.qnaService.updateStatus(
      req.storeDomain,
      productId,
      questionId,
      dto.status,
    );
    if (!question) throw new NotFoundException('Question not found');
    return { data: question };
  }

  @Patch(':productId/:questionId/answer')
  async answerQuestion(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('questionId') questionId: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    dto: AnswerQuestionDto,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const question = await this.qnaService.answerQuestion(
      req.storeDomain,
      productId,
      questionId,
      dto,
    );
    if (!question) throw new NotFoundException('Question not found');
    return { data: question };
  }

  @Delete(':productId/:questionId')
  async deleteQuestion(
    @Param('productId', NumericIdPipe) productId: string,
    @Param('questionId') questionId: string,
    @Req() req: AuthRequest,
  ) {
    requireAuth(req);
    const deleted = await this.qnaService.deleteQuestion(
      req.storeDomain,
      productId,
      questionId,
    );
    if (!deleted) throw new NotFoundException('Question not found');
    return { data: { deleted: true } };
  }
}

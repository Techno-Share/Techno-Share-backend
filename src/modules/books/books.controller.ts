import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BooksService } from './books.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateBookDto } from './dto/create-book.dto';
import { UpdateBookDto } from './dto/update-book.dto';
import { CreateRequestDto } from './dto/create-request.dto';
import { DeclineRequestDto } from './dto/decline-request.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiAuth,
  ApiNotFound,
  ApiOwnerOnly,
  ApiRateLimited,
  ApiUploadLimits,
  ERROR_SCHEMA,
  envelope,
} from '../../common/swagger/api-responses.decorator';
import { API_TAGS } from '../../common/swagger/swagger.config';

type AuthReq = { user: { sub: string } };

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20 MB

@ApiTags(API_TAGS.books)
@Controller('books')
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  @ApiOperation({
    summary: 'Upload a book cover',
    description:
      'Signed in. JPEG, PNG or WebP up to 5 MB. Returns the URL to send as `cover_image_url` when donating.',
  })
  @ApiAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    description: 'Stored. Returns the cover URL.',
    schema: envelope({
      type: 'object',
      properties: { url: { type: 'string' } },
    }),
  })
  @ApiBadRequestResponse({
    description: 'No file sent, or an unsupported image type.',
    schema: ERROR_SCHEMA,
  })
  @ApiUploadLimits(5)
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('upload')
  @Post('upload-cover')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_COVER_SIZE },
      fileFilter: (_req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only JPEG, PNG, and WebP images are allowed',
            ),
            false,
          );
        }
      },
    }),
  )
  uploadCover(
    @Request() req: AuthReq,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    return this.booksService.uploadCover(req.user.sub, file);
  }

  @ApiOperation({
    summary: 'Offer a book',
    description:
      'Signed in. Lists a book for another student to borrow. A cover is required - upload it first through POST /books/upload-cover.',
  })
  @ApiAuth()
  @ApiCreatedResponse({
    description: 'Listed.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiBadRequestResponse({
    description: 'Validation failed.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard)
  @Post()
  donate(@Request() req: AuthReq, @Body() dto: CreateBookDto) {
    return this.booksService.donate(req.user.sub, dto);
  }

  /**
   * Every book on offer, the donor's own listings included — the detail page is
   * where requesting is refused for your own book, not this list.
   *
   * Viewer-aware for one case only: a book with a pending request stays listed
   * for the donor and the requester, and is hidden from everyone else.
   */
  @ApiOperation({
    summary: 'Browse books',
    description:
      'Signed in. Books currently on offer, excluding ones an admin has hidden.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Available books.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(
    @Request() req: AuthReq,
    @Query('major_id') majorId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.booksService.findAll(
      majorId,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
      req.user.sub,
    );
  }

  @ApiOperation({
    summary: 'List the books you offered',
    description:
      'Signed in. Your own listings in every state, hidden ones included.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Your listings.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMyBooks(@Request() req: AuthReq, @Query('filter') filter?: string) {
    const allowed = [
      'all',
      'pending',
      'donated',
      'available',
      'received',
      'reserved',
    ] as const;
    const safe = (allowed as readonly string[]).includes(filter ?? '')
      ? (filter as (typeof allowed)[number])
      : 'all';
    return this.booksService.getMyBooks(req.user.sub, safe);
  }

  @ApiOperation({
    summary: 'Your book statistics',
    description: 'Signed in. Counts for the dashboard.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Counts for this account.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('stats')
  getStats(@Request() req: AuthReq) {
    return this.booksService.getBookStats(req.user.sub);
  }

  @ApiOperation({
    summary: 'Requests for your books',
    description:
      'Signed in. Requests other students have made for books you offered.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Incoming requests.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('requests/incoming')
  getIncomingRequests(@Request() req: AuthReq) {
    return this.booksService.getIncomingRequests(req.user.sub);
  }

  @ApiOperation({
    summary: 'Requests you have made',
    description: 'Signed in. Requests you made for other students’ books.',
  })
  @ApiAuth()
  @ApiOkResponse({
    description: 'Outgoing requests.',
    schema: envelope({
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    }),
  })
  @UseGuards(JwtAuthGuard)
  @Get('requests/outgoing')
  getOutgoingRequests(
    @Request() req: AuthReq,
    @Query('status') status?: string,
  ) {
    const allowed = ['pending', 'accepted', 'declined'] as const;
    const safe = (allowed as readonly string[]).includes(status ?? '')
      ? (status as 'pending' | 'accepted' | 'declined')
      : undefined;
    return this.booksService.getOutgoingRequests(req.user.sub, safe);
  }

  @ApiOperation({
    summary: 'Get one request',
    description:
      'Signed in, and a party to it - the donor or the requester. Contact details are only released once the request is accepted.',
  })
  @ApiAuth()
  @ApiParam({
    name: 'requestId',
    format: 'uuid',
    description: 'The request to fetch.',
  })
  @ApiOkResponse({
    description: 'The request.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('You are not a party to this request.')
  @ApiNotFound('No such request.')
  @UseGuards(JwtAuthGuard)
  @Get('request/:requestId')
  getRequestDetail(
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.getRequestDetail(requestId, req.user.sub);
  }

  /**
   * Guarded so the donor can be recognised: only they are told who has a
   * request pending on their book. The route is already behind requiresAuth
   * on the client.
   */
  @ApiOperation({
    summary: 'Get one book',
    description: 'Signed in. The listing with its donor and current status.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book to fetch.' })
  @ApiOkResponse({
    description: 'The listing.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such book.')
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: AuthReq) {
    return this.booksService.findOne(id, req.user.sub);
  }

  @ApiOperation({
    summary: 'Edit your listing',
    description:
      'Signed in, owner only. Refused once someone is waiting on it - a listing freezes while a request is open, so its details cannot change under the requester.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book to edit.' })
  @ApiOkResponse({
    description: 'Updated.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('You did not list this book.')
  @ApiNotFound('No such book.')
  @ApiConflictResponse({
    description: 'A request is open on this listing.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Request() req: AuthReq,
    @Body() dto: UpdateBookDto,
  ) {
    return this.booksService.update(id, req.user.sub, dto);
  }

  @ApiOperation({
    summary: 'Delete your listing',
    description:
      'Signed in, owner only. Refused while a request is open on it.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book to delete.' })
  @ApiOkResponse({
    description: 'Deleted.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('You did not list this book.')
  @ApiNotFound('No such book.')
  @ApiConflictResponse({
    description: 'A request is open on this listing.',
    schema: ERROR_SCHEMA,
  })
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: AuthReq) {
    return this.booksService.remove(id, req.user.sub);
  }

  @ApiOperation({
    summary: 'Request a book',
    description:
      'Signed in, and not your own listing. Notifies the donor. A book takes one request at a time.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book to request.' })
  @ApiCreatedResponse({
    description: 'Request sent and the donor notified.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiNotFound('No such book.')
  @ApiConflictResponse({
    description: 'Already requested, or the book is no longer available.',
    schema: ERROR_SCHEMA,
  })
  @ApiRateLimited()
  @UseGuards(JwtAuthGuard)
  @RateLimitTier('book-request')
  @Post(':id/request')
  request(
    @Param('id') id: string,
    @Request() req: AuthReq,
    @Body() dto: CreateRequestDto,
  ) {
    return this.booksService.request(id, req.user.sub, dto);
  }

  /**
   * Accept a request. One click — where and when is settled on Telegram, so
   * there is nothing to fill in. The book becomes reserved, not donated.
   */
  @ApiOperation({
    summary: 'Accept a request',
    description:
      'Signed in, donor only. Releases both parties’ contact details so they can arrange the handover, and notifies the requester.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book.' })
  @ApiParam({
    name: 'requestId',
    format: 'uuid',
    description: 'The request to accept.',
  })
  @ApiOkResponse({
    description: 'Accepted; contact details released.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the donor can accept.')
  @ApiNotFound('No such book or request.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/accept')
  accept(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.accept(id, requestId, req.user.sub);
  }

  /**
   * Call off a reservation. Either side may: the receiver who never collected,
   * or the donor who changed their mind. The book returns to available.
   */
  @ApiOperation({
    summary: 'Cancel a request',
    description:
      'Signed in. Either party may cancel - the donor or the requester - and the listing returns to available. There is no automatic expiry: a reservation ends only when someone ends it.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book.' })
  @ApiParam({
    name: 'requestId',
    format: 'uuid',
    description: 'The request to cancel.',
  })
  @ApiOkResponse({
    description: 'Cancelled; the listing is available again.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('You are not a party to this request.')
  @ApiNotFound('No such book or request.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/cancel')
  cancelRequest(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.cancel(id, requestId, req.user.sub);
  }

  /**
   * The RECEIVER confirms the book changed hands. This is what marks it
   * donated — acceptance only reserves it.
   */
  @ApiOperation({
    summary: 'Mark the handover done',
    description:
      'Signed in, donor only. Closes the request and takes the listing down.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book.' })
  @ApiParam({
    name: 'requestId',
    format: 'uuid',
    description: 'The request to complete.',
  })
  @ApiOkResponse({
    description: 'Completed.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the donor can complete.')
  @ApiNotFound('No such book or request.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/complete')
  complete(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
  ) {
    return this.booksService.complete(id, requestId, req.user.sub);
  }

  @ApiOperation({
    summary: 'Decline a request',
    description:
      'Signed in, donor only. The reason is shown to the requester so a refusal is not silent, and the listing returns to available.',
  })
  @ApiAuth()
  @ApiParam({ name: 'id', format: 'uuid', description: 'The book.' })
  @ApiParam({
    name: 'requestId',
    format: 'uuid',
    description: 'The request to decline.',
  })
  @ApiOkResponse({
    description: 'Declined; the listing is available again.',
    schema: envelope({ type: 'object', additionalProperties: true }),
  })
  @ApiOwnerOnly('Only the donor can decline.')
  @ApiNotFound('No such book or request.')
  @UseGuards(JwtAuthGuard)
  @Patch(':id/request/:requestId/decline')
  decline(
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Request() req: AuthReq,
    @Body() dto: DeclineRequestDto,
  ) {
    return this.booksService.decline(id, requestId, req.user.sub, dto.reason);
  }
}

import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { ImageOptimizeService } from './image-optimize.service';

@Global()
@Module({
  providers: [StorageService, ImageOptimizeService],
  exports: [StorageService, ImageOptimizeService],
})
export class StorageModule {}

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProductService } from './product.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { Product } from '@prisma/client';
import { GetProductsDto } from './dto/get-products.dto';
import { AuthGuard } from '@nestjs/passport';
import { AdminGuard } from 'src/shared/guards/admin.guard';

@ApiTags('products')
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'), AdminGuard)
  @ApiOperation({ summary: 'Create product' })
  @ApiCreatedResponse({ type: Object, description: 'Created product' })
  @ApiBody({ type: CreateProductDto })
  async create(@Body() createProductDto: CreateProductDto): Promise<Product> {
    return await this.productService.create(createProductDto);
  }

  @Get()
  @ApiOperation({ summary: 'List products (paginated, name search)' })
  @ApiOkResponse({
    description: 'Paginated products with optional name filter',
  })
  async findAll(@Query() query: GetProductsDto): Promise<{
    items: Product[];
    total: number;
    page: number;
    limit: number;
    pages: number;
  }> {
    return await this.productService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get product by id' })
  @ApiParam({ name: 'id', description: 'UUID of the product' })
  @ApiOkResponse({
    type: Object,
    description: 'Product (or null if not found)',
  })
  async findOne(@Param('id') id: string): Promise<Product | null> {
    return await this.productService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(AuthGuard('jwt'), AdminGuard)
  @ApiOperation({ summary: 'Update product' })
  @ApiParam({ name: 'id', description: 'UUID of the product' })
  @ApiOkResponse({ type: Object, description: 'Updated product' })
  @ApiBody({ type: UpdateProductDto })
  async update(
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
  ): Promise<Product> {
    return await this.productService.update(id, updateProductDto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), AdminGuard)
  @ApiOperation({ summary: 'Delete product' })
  @ApiParam({ name: 'id', description: 'UUID of the product' })
  @ApiOkResponse({ type: Object, description: 'Deleted product' })
  async remove(@Param('id') id: string): Promise<Product> {
    return await this.productService.remove(id);
  }
}

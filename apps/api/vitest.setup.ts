// Decorators (`@Injectable`, `@Inject`, `@Controller`) call Reflect.defineMetadata
// at class-definition time, so the polyfill must load before any decorated class.
import 'reflect-metadata';

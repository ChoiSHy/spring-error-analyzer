import { AnalysisResult, ErrorBlock } from '../types';

interface ErrorPattern {
  name: string;
  pattern: RegExp;
  title: string;
  description: string;
  suggestion: string;
  confidence: number;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    name: 'NullPointerException',
    pattern: /NullPointerException/i,
    title: 'Null Pointer Exception',
    description:
      'null 참조에 대해 메서드를 호출하거나 필드에 접근하려 했습니다.',
    suggestion:
      '1. 해당 객체가 null이 될 수 있는 경로를 확인하세요.\n2. Optional<T>을 사용하여 null 안전하게 처리하세요.\n3. @NonNull / @Nullable 어노테이션을 활용하세요.\n4. 스택트레이스에서 정확한 라인 번호를 확인하고 해당 변수의 초기화 여부를 점검하세요.',
    confidence: 0.85,
  },
  {
    name: 'ClassNotFoundException',
    pattern: /ClassNotFoundException|NoClassDefFoundError/i,
    title: 'Class Not Found',
    description:
      '필요한 클래스를 classpath에서 찾을 수 없습니다.',
    suggestion:
      '1. build.gradle 또는 pom.xml에서 필요한 의존성이 포함되어 있는지 확인하세요.\n2. 패키지명과 클래스명의 오타를 확인하세요.\n3. `./gradlew dependencies` 또는 `mvn dependency:tree`로 의존성 트리를 점검하세요.\n4. IDE의 캐시를 정리하고 다시 빌드해보세요.',
    confidence: 0.8,
  },
  {
    name: 'BeanCreationException',
    pattern: /BeanCreationException|BeanInstantiationException/i,
    title: 'Bean Creation Failed',
    description:
      'Spring Bean 생성 중 오류가 발생했습니다. 순환 참조, 생성자 매개변수 불일치, 또는 초기화 실패일 수 있습니다.',
    suggestion:
      '1. 순환 참조(Circular Dependency)가 없는지 확인하세요.\n2. @Lazy 어노테이션으로 순환 참조를 해결할 수 있습니다.\n3. 생성자의 매개변수 타입과 Bean 정의가 일치하는지 확인하세요.\n4. @Configuration 클래스의 @Bean 메서드가 올바르게 설정되었는지 점검하세요.',
    confidence: 0.8,
  },
  {
    name: 'NoSuchBeanDefinitionException',
    pattern: /NoSuchBeanDefinitionException/i,
    title: 'Bean Not Found',
    description:
      '요청된 타입 또는 이름의 Bean을 Spring 컨테이너에서 찾을 수 없습니다.',
    suggestion:
      '1. 해당 클래스에 @Component, @Service, @Repository, @Controller 어노테이션이 있는지 확인하세요.\n2. @ComponentScan의 base-package가 올바른지 확인하세요.\n3. 인터페이스를 주입하는 경우 구현체가 존재하는지 확인하세요.\n4. 프로파일(@Profile) 설정이 현재 활성 프로파일과 일치하는지 확인하세요.',
    confidence: 0.85,
  },
  {
    name: 'PortAlreadyInUse',
    pattern: /Address already in use|BindException.*\d{4,5}|PortInUseException/i,
    title: 'Port Already In Use',
    description:
      '지정된 포트가 이미 다른 프로세스에 의해 사용 중입니다.',
    suggestion:
      '1. `netstat -ano | findstr :<port>` (Windows) 또는 `lsof -i :<port>` (Mac/Linux)로 포트 사용 중인 프로세스를 확인하세요.\n2. application.properties에서 `server.port`를 다른 값으로 변경하세요.\n3. 기존 프로세스를 종료하세요.\n4. 랜덤 포트를 사용하려면 `server.port=0`으로 설정하세요.',
    confidence: 0.95,
  },
  {
    name: 'DataAccessException',
    pattern: /DataAccessException|SQLException|JDBCConnectionException|CannotCreateTransactionException/i,
    title: 'Database Access Error',
    description:
      '데이터베이스 연결 또는 쿼리 실행 중 오류가 발생했습니다.',
    suggestion:
      '1. application.properties의 DB 연결 정보(url, username, password)를 확인하세요.\n2. 데이터베이스 서버가 실행 중인지 확인하세요.\n3. 네트워크 연결 및 방화벽 설정을 점검하세요.\n4. 커넥션 풀 설정(HikariCP)이 적절한지 확인하세요.\n5. DDL auto 설정(`spring.jpa.hibernate.ddl-auto`)을 확인하세요.',
    confidence: 0.75,
  },
  {
    name: 'HttpMessageNotReadableException',
    pattern: /HttpMessageNotReadableException|JsonParseException|JsonMappingException/i,
    title: 'Invalid Request Body',
    description:
      'HTTP 요청 본문을 파싱할 수 없습니다. JSON 형식이 잘못되었거나 타입이 맞지 않습니다.',
    suggestion:
      '1. 요청 본문의 JSON 형식이 올바른지 확인하세요.\n2. Content-Type 헤더가 application/json인지 확인하세요.\n3. DTO 클래스의 필드 타입이 요청 데이터와 일치하는지 확인하세요.\n4. @RequestBody 어노테이션이 올바르게 사용되었는지 확인하세요.',
    confidence: 0.9,
  },
  {
    name: 'MethodArgumentNotValidException',
    pattern: /MethodArgumentNotValidException|ConstraintViolationException/i,
    title: 'Validation Failed',
    description:
      '요청 데이터의 유효성 검증에 실패했습니다.',
    suggestion:
      '1. DTO 클래스의 @Valid, @NotNull, @NotBlank 등의 검증 어노테이션을 확인하세요.\n2. 요청 데이터가 검증 조건을 만족하는지 확인하세요.\n3. 커스텀 Validator가 올바르게 구현되었는지 점검하세요.\n4. @ExceptionHandler를 통해 적절한 에러 응답을 반환하세요.',
    confidence: 0.9,
  },
  {
    name: 'OutOfMemoryError',
    pattern: /OutOfMemoryError|Java heap space|GC overhead limit/i,
    title: 'Out of Memory',
    description:
      'JVM 메모리가 부족합니다.',
    suggestion:
      '1. JVM 힙 메모리를 증가시키세요: `-Xmx512m` → `-Xmx1024m`\n2. 메모리 누수가 있는지 프로파일링 도구로 확인하세요.\n3. 대량 데이터 처리 시 페이징 또는 스트리밍을 사용하세요.\n4. 불필요한 객체 참조를 해제하세요.',
    confidence: 0.8,
  },
  {
    name: 'StackOverflowError',
    pattern: /StackOverflowError/i,
    title: 'Stack Overflow',
    description:
      '재귀 호출이 너무 깊거나 무한 루프가 발생했습니다.',
    suggestion:
      '1. 스택트레이스에서 반복되는 메서드 호출 패턴을 찾으세요.\n2. 재귀의 종료 조건을 확인하세요.\n3. 엔티티 간 양방향 관계에서 toString(), hashCode() 등이 무한 재귀를 일으키지 않는지 확인하세요.\n4. @JsonIgnore 또는 @ToString.Exclude를 사용하여 순환 참조를 방지하세요.',
    confidence: 0.85,
  },
];

export class LocalAnalyzer {
  canHandle(error: ErrorBlock): boolean {
    const fullText = [error.message, ...error.stackTrace].join('\n');
    return ERROR_PATTERNS.some((p) => p.pattern.test(fullText));
  }

  analyze(error: ErrorBlock): AnalysisResult | null {
    const fullText = [error.message, ...error.stackTrace].join('\n');

    for (const pattern of ERROR_PATTERNS) {
      if (pattern.pattern.test(fullText)) {
        return {
          errorId: error.id,
          serviceId: error.serviceId,
          analysisType: 'local',
          title: pattern.title,
          description: pattern.description,
          suggestion: pattern.suggestion,
          confidence: pattern.confidence,
          timestamp: new Date().toISOString(),
          errorBlock: error,
        };
      }
    }

    return null;
  }
}

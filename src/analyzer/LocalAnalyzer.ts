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
    name: 'BadSqlGrammarException',
    pattern: /BadSqlGrammarException|bad SQL grammar|### SQL:|### Cause:|StatementCallback|PreparedStatementCallback|CUBRIDException|Syntax error.*unexpected/i,
    title: 'SQL Grammar Error (MyBatis/JPA)',
    description:
      'MyBatis Mapper XML 또는 JPA에서 실행된 SQL 쿼리의 문법 또는 컬럼·테이블명이 DB에서 인식되지 않습니다.',
    suggestion:
      '1. 에러 로그에서 "### SQL:" 구문과 "### Cause:" 아래 DB 오류 메시지를 확인하세요.\n2. Mapper XML의 쿼리에 사용된 컬럼명이 실제 테이블 스키마와 일치하는지 확인하세요.\n3. DB별 예약어 또는 대소문자 규칙을 확인하세요 (예: CUBRID은 대소문자 구분).\n4. UNION ALL 등 복합 쿼리 사용 시 각 SELECT의 컬럼 개수와 타입이 일치하는지 확인하세요.\n5. #{param} 바인딩 타입이 컬럼 타입과 호환되는지 확인하세요.',
    confidence: 0.88,
  },
  {
    name: 'DataAccessException',
    pattern: /DataAccessException|SQLException|JDBCConnectionException|CannotCreateTransactionException|MyBatisSystemException|PersistenceException/i,
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
    pattern: /MethodArgumentNotValidException|ConstraintViolationException|Validation failed for argument|rejected value|Field error in object/i,
    title: 'Validation Failed',
    description:
      '요청 데이터의 유효성 검증에 실패했습니다. 필드 값이 제약 조건(@Size, @NotNull, @Min 등)을 위반했습니다.',
    suggestion:
      '1. 에러 메시지에서 "Field error in object" 아래 어떤 필드가 어떤 조건을 위반했는지 확인하세요.\n2. DTO 클래스의 @Valid, @NotNull, @NotBlank, @Size 등의 검증 어노테이션을 확인하세요.\n3. 요청 데이터가 검증 조건(최소/최대 크기, 필수값 등)을 만족하는지 확인하세요.\n4. 커스텀 Validator가 올바르게 구현되었는지 점검하세요.\n5. @ExceptionHandler(MethodArgumentNotValidException.class)를 통해 적절한 에러 응답을 반환하도록 처리하세요.',
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
  // ── 추가 패턴 ──────────────────────────────────────────────────────────────
  {
    name: 'HttpRequestMethodNotSupportedException',
    pattern: /HttpRequestMethodNotSupportedException|Request method .* not supported/i,
    title: 'HTTP Method Not Supported',
    description:
      '요청한 HTTP 메서드(GET, POST, PUT 등)를 해당 엔드포인트에서 지원하지 않습니다.',
    suggestion:
      '1. 클라이언트가 올바른 HTTP 메서드를 사용하는지 확인하세요 (예: GET → POST).\n2. @GetMapping, @PostMapping 등 컨트롤러의 매핑 어노테이션을 확인하세요.\n3. Swagger/API 문서에서 해당 엔드포인트가 허용하는 메서드를 확인하세요.',
    confidence: 0.95,
  },
  {
    name: 'NoHandlerFoundException',
    pattern: /NoHandlerFoundException|No handler found for|NoResourceFoundException/i,
    title: '404 - Handler Not Found',
    description:
      '요청한 URL에 매핑된 컨트롤러 또는 정적 리소스가 없습니다.',
    suggestion:
      '1. 요청 URL과 컨트롤러의 @RequestMapping / @GetMapping 경로가 일치하는지 확인하세요.\n2. URL 오타 및 대소문자를 확인하세요.\n3. @RestController / @Controller 어노테이션이 누락되지 않았는지 확인하세요.\n4. Spring MVC 설정에서 `spring.mvc.throw-exception-if-no-handler-found=true`와 `spring.web.resources.add-mappings=false`를 설정하면 이 예외가 발생합니다.',
    confidence: 0.92,
  },
  {
    name: 'AccessDeniedException',
    pattern: /AccessDeniedException|access is denied|Access Denied/i,
    title: 'Access Denied (권한 없음)',
    description:
      'Spring Security에서 현재 사용자의 권한이 해당 리소스 접근에 충분하지 않습니다.',
    suggestion:
      '1. 현재 사용자의 Role/Authority가 @PreAuthorize, @Secured 또는 SecurityConfig의 조건을 만족하는지 확인하세요.\n2. JWT 토큰이나 세션이 올바른 권한(Role)을 포함하고 있는지 확인하세요.\n3. SecurityConfig의 `.antMatchers()` / `.requestMatchers()` 설정을 점검하세요.\n4. @EnableMethodSecurity (또는 @EnableGlobalMethodSecurity) 어노테이션이 활성화되어 있는지 확인하세요.',
    confidence: 0.90,
  },
  {
    name: 'AuthenticationException',
    pattern: /AuthenticationException|InsufficientAuthenticationException|BadCredentialsException|UsernameNotFoundException|JwtException|ExpiredJwtException|SignatureException/i,
    title: 'Authentication Failed (인증 실패)',
    description:
      '사용자 인증에 실패했습니다. 잘못된 자격증명, 만료된 토큰, 또는 서명 불일치가 원인일 수 있습니다.',
    suggestion:
      '1. JWT를 사용하는 경우 토큰 만료 여부(exp claim)를 확인하세요.\n2. JWT Secret Key가 서명·검증 양쪽에서 동일한지 확인하세요.\n3. UsernameNotFoundException: UserDetailsService에서 해당 사용자가 존재하는지 확인하세요.\n4. BadCredentialsException: 비밀번호 인코더(BCryptPasswordEncoder 등)가 일치하는지 확인하세요.\n5. 인증 필터(JwtAuthenticationFilter 등)의 순서와 설정을 점검하세요.',
    confidence: 0.88,
  },
  {
    name: 'TransactionRollback',
    pattern: /TransactionSystemException|RollbackException|UnexpectedRollbackException|transaction.*rolled back|rollback.*exception/i,
    title: 'Transaction Rollback',
    description:
      '트랜잭션이 예기치 않게 롤백되었습니다.',
    suggestion:
      '1. @Transactional 메서드 내에서 RuntimeException이 발생했는지 확인하세요.\n2. rollbackFor / noRollbackFor 설정이 의도와 맞는지 확인하세요.\n3. 중첩 트랜잭션(REQUIRES_NEW, NESTED)의 propagation 설정을 점검하세요.\n4. 체크드 예외(Checked Exception)는 기본적으로 롤백되지 않으므로 rollbackFor를 명시하세요.',
    confidence: 0.82,
  },
  {
    name: 'DuplicateKeyException',
    pattern: /DuplicateKeyException|Duplicate entry|duplicate key value|unique constraint|ORA-00001|ERROR 1062/i,
    title: 'Duplicate Key / Unique Constraint Violation',
    description:
      'DB의 PK 또는 Unique 제약 조건을 위반하는 중복 데이터를 삽입하려 했습니다.',
    suggestion:
      '1. INSERT 전에 중복 여부를 먼저 조회(existsBy...)하거나 upsert 쿼리를 사용하세요.\n2. 에러 메시지에서 중복된 키 값과 컬럼명을 확인하세요.\n3. JPA의 경우 merge() 대신 save()를 잘못 사용한 경우가 아닌지 확인하세요.\n4. 배치 처리 시 동시성 문제로 발생할 수 있으므로 분산 락(Distributed Lock)을 고려하세요.',
    confidence: 0.90,
  },
  {
    name: 'LazyInitializationException',
    pattern: /LazyInitializationException|could not initialize proxy|failed to lazily initialize/i,
    title: 'Lazy Initialization Exception (JPA)',
    description:
      'JPA 영속성 컨텍스트(Session)가 닫힌 후 지연 로딩(Lazy Loading) 프록시에 접근하려 했습니다.',
    suggestion:
      '1. @Transactional 범위 밖에서 연관 엔티티에 접근하는 코드를 확인하세요.\n2. JPQL에서 fetch join을 사용하여 필요한 연관 데이터를 즉시 로딩하세요.\n3. DTO로 변환하는 작업을 트랜잭션 내부에서 수행하세요.\n4. 필요한 경우 FetchType.EAGER로 변경하되 N+1 문제에 주의하세요.\n5. Open Session In View 패턴은 안티패턴으로 권장되지 않습니다.',
    confidence: 0.93,
  },
  {
    name: 'TimeoutException',
    pattern: /TimeoutException|Read timed out|Connection timed out|SocketTimeoutException|ConnectTimeoutException|gateway timeout/i,
    title: 'Timeout',
    description:
      '외부 API 호출, DB 쿼리, 또는 네트워크 연결이 설정된 제한 시간을 초과했습니다.',
    suggestion:
      '1. 슬로우 쿼리 여부를 DB의 slow query log로 확인하고 인덱스를 점검하세요.\n2. RestTemplate/WebClient의 connectTimeout, readTimeout 설정값을 확인하세요.\n3. 외부 서비스의 응답이 지연되는 경우 Circuit Breaker(Resilience4j)를 도입하세요.\n4. HikariCP의 connectionTimeout, idleTimeout 설정을 점검하세요.',
    confidence: 0.83,
  },
  {
    name: 'MissingServletRequestParameterException',
    pattern: /MissingServletRequestParameterException|MissingPathVariableException|Required request parameter|Required URI template variable/i,
    title: 'Required Request Parameter Missing',
    description:
      '필수 요청 파라미터(@RequestParam) 또는 경로 변수(@PathVariable)가 요청에 포함되지 않았습니다.',
    suggestion:
      '1. 에러 메시지에서 누락된 파라미터 이름을 확인하세요.\n2. 선택적 파라미터라면 @RequestParam(required = false, defaultValue = "...")을 사용하세요.\n3. 클라이언트 요청 URL/Body에 해당 파라미터가 포함되어 있는지 확인하세요.\n4. @PathVariable의 경우 URL 템플릿 경로와 변수명이 일치하는지 확인하세요.',
    confidence: 0.92,
  },
  {
    name: 'MultipartException',
    pattern: /MultipartException|MaxUploadSizeExceededException|FileSizeLimitExceededException|multipart.*exceeded/i,
    title: 'File Upload Size Exceeded',
    description:
      '업로드한 파일 또는 요청 크기가 설정된 최대값을 초과했습니다.',
    suggestion:
      '1. application.properties에서 업로드 크기 제한을 조정하세요:\n   - `spring.servlet.multipart.max-file-size=10MB`\n   - `spring.servlet.multipart.max-request-size=20MB`\n2. Nginx 등 리버스 프록시를 사용하는 경우 `client_max_body_size`도 함께 조정하세요.\n3. 대용량 파일은 분할 업로드(Multipart Upload) 방식을 고려하세요.',
    confidence: 0.92,
  },
  // ── 신규 패턴 ──────────────────────────────────────────────────────────────
  {
    name: 'UnsatisfiedDependencyException',
    pattern: /UnsatisfiedDependencyException|unsatisfied dependency expressed through|parameter \d+ of constructor in/i,
    title: 'Unsatisfied Dependency (의존성 주입 실패)',
    description:
      'Spring이 Bean을 생성할 때 생성자 또는 필드에 주입할 의존성을 해결하지 못했습니다. 주로 Bean이 없거나, 타입이 일치하지 않거나, 순환 참조가 원인입니다.',
    suggestion:
      '1. 에러 메시지의 "parameter N of constructor in ..." 부분에서 어떤 Bean이 문제인지 확인하세요.\n2. 해당 클래스에 @Component / @Service / @Repository 등의 어노테이션이 있는지 확인하세요.\n3. 인터페이스를 주입받는 경우, 구현체가 하나인지 확인하세요 (여럿이면 @Qualifier 사용).\n4. 순환 참조라면 @Lazy를 한 쪽에 붙이거나, 설계를 재검토하세요.\n5. `spring.main.allow-circular-references=true`는 임시 방편이므로 근본 원인을 수정하세요.',
    confidence: 0.90,
  },
  {
    name: 'CircularDependencyException',
    pattern: /The dependencies of some of the beans in the application context form a cycle|circular dependency|circular reference/i,
    title: 'Circular Dependency (순환 참조)',
    description:
      'Bean A가 Bean B를 의존하고, Bean B가 다시 Bean A를 의존하는 순환 참조가 발생했습니다. Spring Boot 2.6 이상에서는 기본적으로 순환 참조를 허용하지 않습니다.',
    suggestion:
      '1. 에러 메시지에 표시된 순환 참조 체인(A → B → A)을 확인하세요.\n2. 의존 관계를 재설계하여 순환을 끊으세요 (예: 공통 로직을 별도 서비스로 분리).\n3. 한쪽에 @Lazy 어노테이션을 추가하면 초기화 시점을 늦춰 해결할 수 있습니다.\n4. 생성자 주입 대신 세터 주입(@Setter + @Autowired)으로 임시 해결할 수 있습니다.\n5. 임시 방편으로 spring.main.allow-circular-references=true를 설정할 수 있지만, 근본 원인 수정을 권장합니다.',
    confidence: 0.95,
  },
  {
    name: 'PropertyNotFoundException',
    pattern: /Could not resolve placeholder|IllegalArgumentException.*\$\{|No such property|Could not bind properties|Binding to target .* failed|Failed to bind properties/i,
    title: 'Property / Configuration Binding 실패',
    description:
      'application.properties (또는 yml)에 필요한 설정값이 없거나, @ConfigurationProperties 바인딩에 실패했습니다.',
    suggestion:
      '1. 에러 메시지에서 어떤 키가 누락됐는지 확인하세요 (예: ${my.config.key}).\n2. application.properties 또는 application.yml에 해당 키가 정의되어 있는지 확인하세요.\n3. 활성 프로파일(spring.profiles.active)에 맞는 properties 파일이 로드되고 있는지 확인하세요.\n4. @ConfigurationProperties 클래스의 필드 타입이 설정값과 호환되는지 확인하세요.\n5. 환경 변수나 시스템 프로퍼티로 값을 주입하는 경우, 해당 값이 실제로 설정되어 있는지 확인하세요.',
    confidence: 0.88,
  },
  {
    name: 'ConnectException',
    pattern: /ConnectException|Connection refused|ECONNREFUSED|Failed to connect|Unable to connect to|connect timed out|Cannot connect to/i,
    title: 'Connection Refused (외부 서비스 연결 실패)',
    description:
      '외부 서비스(데이터베이스, Redis, Kafka, 외부 API 등)에 연결할 수 없습니다. 대상 서버가 실행 중이지 않거나 네트워크/방화벽 문제일 수 있습니다.',
    suggestion:
      '1. 대상 서버(DB, Redis, Kafka 등)가 실행 중인지 확인하세요.\n2. application.properties의 연결 정보(host, port)가 올바른지 확인하세요.\n3. 방화벽 또는 보안 그룹 설정에서 해당 포트가 열려 있는지 확인하세요.\n4. Docker 환경이라면 컨테이너 간 네트워크 설정(docker-compose network)을 확인하세요.\n5. 연결 재시도 로직(Retry)이나 Circuit Breaker(Resilience4j)를 도입하여 장애 내성을 높이세요.',
    confidence: 0.87,
  },
  {
    name: 'EntityNotFoundException',
    pattern: /EntityNotFoundException|javax\.persistence\.EntityNotFoundException|jakarta\.persistence\.EntityNotFoundException|No entity found for query|Unable to find .* with id/i,
    title: 'Entity Not Found (JPA)',
    description:
      '요청한 ID에 해당하는 엔티티가 데이터베이스에 존재하지 않습니다.',
    suggestion:
      '1. 조회하는 ID 값이 실제로 DB에 존재하는지 확인하세요.\n2. findById() 대신 getById() / getReferenceById()를 사용하면 이 예외가 발생할 수 있습니다. findById()를 사용하고 Optional을 처리하세요.\n3. 삭제된 데이터를 조회하는 경우라면 soft delete 여부를 확인하세요.\n4. 테스트 데이터(Seed Data)가 초기화되어 있는지 확인하세요.\n5. @ExceptionHandler(EntityNotFoundException.class)로 적절한 404 응답을 반환하도록 처리하세요.',
    confidence: 0.90,
  },
  {
    name: 'OptimisticLockingException',
    pattern: /OptimisticLockingFailureException|ObjectOptimisticLockingFailureException|StaleObjectStateException|OptimisticLock|Row was updated or deleted by another transaction/i,
    title: 'Optimistic Locking 충돌',
    description:
      '동시에 같은 엔티티를 수정하려는 트랜잭션이 충돌하여 낙관적 잠금(Optimistic Locking) 예외가 발생했습니다. 다른 트랜잭션이 먼저 해당 행을 수정했습니다.',
    suggestion:
      '1. 엔티티에 @Version 필드가 올바르게 설정되어 있는지 확인하세요.\n2. 충돌 발생 시 재시도(Retry) 로직을 구현하세요 (Spring Retry의 @Retryable 활용).\n3. 충돌이 잦다면 비즈니스 로직을 재검토하거나, 필요한 경우 비관적 잠금(@Lock(LockModeType.PESSIMISTIC_WRITE))으로 전환하세요.\n4. 클라이언트에 409 Conflict 응답을 반환하여 재시도를 유도하세요.\n5. 배치 처리 시 단위를 작게 나누어 충돌 범위를 줄이세요.',
    confidence: 0.92,
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
